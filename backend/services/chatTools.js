import Item from "../models/item.model.js";
import Shop from "../models/shop.model.js";
import Order from "../models/order.model.js";
import { semanticSearchItems } from "./embedding.service.js";

// Function declarations handed to Gemini's function-calling API. Each name
// here must have a matching entry in TOOL_EXECUTORS below.
export const toolDeclarations = [
  {
    functionDeclarations: [
      {
        name: "compareItemPrices",
        description:
          "Compare the price of a specific food item (e.g. 'butter chicken', 'margherita pizza') across different restaurants/shops in a city. Use this whenever the user asks to compare prices or find the cheapest version of a dish.",
        parameters: {
          type: "OBJECT",
          properties: {
            itemName: { type: "STRING", description: "Name (or partial name) of the food item to compare" },
            city: { type: "STRING", description: "City to search in" },
          },
          required: ["itemName", "city"],
        },
      },
      {
        name: "searchMenuItems",
        description:
          "Search for food items across shops in a city by name, category, or price/diet filters. Use this for general 'what can I get', 'show me vegetarian options', or budget-based searches.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Search text matched against item name or category (optional)" },
            city: { type: "STRING", description: "City to search in" },
            maxPrice: { type: "NUMBER", description: "Optional maximum price in rupees" },
            type: { type: "STRING", enum: ["veg", "non veg"], description: "Optional dietary filter" },
          },
          required: ["city"],
        },
      },
      {
        name: "getShopsInCity",
        description: "List restaurants/shops available in a given city. Use this when the user asks what restaurants are near them or in a city.",
        parameters: {
          type: "OBJECT",
          properties: {
            city: { type: "STRING", description: "City to search in" },
          },
          required: ["city"],
        },
      },
      {
        name: "getOrderStatus",
        description:
          "Get the current status of one of the signed-in user's own orders by order ID. Only works for the currently authenticated user's own orders.",
        parameters: {
          type: "OBJECT",
          properties: {
            orderId: { type: "STRING", description: "The order's MongoDB ObjectId, as given by the user" },
          },
          required: ["orderId"],
        },
      },
      {
        name: "getOrderHistory",
        description:
          "Get the signed-in user's recent past orders (what they ordered, from where, when, and for how much). Use this for 'what did I order last time' or 'reorder my usual' style questions.",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "NUMBER", description: "How many recent orders to return (default 5, max 10)" },
          },
        },
      },
    ],
  },
];

const cityRegex = (city) => new RegExp(`^${city.trim()}$`, "i");

async function compareItemPrices({ itemName, city }) {
  if (!itemName || !city) return { error: "itemName and city are required" };

  const shops = await Shop.find({ city: cityRegex(city) }).select("_id name").lean();
  if (!shops.length) return { results: [], message: `No shops found in ${city}` };

  const shopIds = shops.map((s) => s._id);
  const shopById = new Map(shops.map((s) => [s._id.toString(), s.name]));

  const items = await Item.find({
    shop: { $in: shopIds },
    availability: true,
    name: { $regex: itemName, $options: "i" },
  })
    .select("name price rating type category shop")
    .sort({ price: 1 })
    .limit(10)
    .lean();

  return {
    results: items.map((i) => ({
      itemName: i.name,
      shopName: shopById.get(i.shop.toString()),
      price: i.price,
      rating: i.rating?.average || null,
      type: i.type || null,
      category: i.category,
    })),
  };
}

async function searchMenuItems({ query, city, maxPrice, type }) {
  if (!city) return { error: "city is required" };

  // Use semantic RAG vector search for descriptive/natural language queries
  if (query && query.trim()) {
    try {
      const semanticRes = await semanticSearchItems({
        query,
        city,
        maxPrice,
        type,
        limit: 15,
      });
      if (semanticRes.results && semanticRes.results.length > 0) {
        return {
          results: semanticRes.results.map((i) => ({
            itemName: i.name,
            shopName: i.shopName,
            price: i.price,
            rating: i.rating,
            type: i.type,
            category: i.category,
            similarityScore: i.similarityScore,
          })),
          searchMode: semanticRes.source,
        };
      }
    } catch (err) {
      // Fallback to regex filter on error
    }
  }

  const shops = await Shop.find({ city: cityRegex(city) }).select("_id name").lean();
  if (!shops.length) return { results: [], message: `No shops found in ${city}` };

  const shopIds = shops.map((s) => s._id);
  const shopById = new Map(shops.map((s) => [s._id.toString(), s.name]));

  const filter = { shop: { $in: shopIds }, availability: true };
  if (query) {
    filter.$or = [
      { name: { $regex: query, $options: "i" } },
      { category: { $regex: query, $options: "i" } },
    ];
  }
  if (typeof maxPrice === "number") filter.price = { $lte: maxPrice };
  if (type === "veg" || type === "non veg") filter.type = type;

  const items = await Item.find(filter)
    .select("name price rating type category shop")
    .sort({ price: 1 })
    .limit(15)
    .lean();

  return {
    results: items.map((i) => ({
      itemName: i.name,
      shopName: shopById.get(i.shop.toString()),
      price: i.price,
      rating: i.rating?.average || null,
      type: i.type || null,
      category: i.category,
    })),
  };
}

async function getShopsInCity({ city }) {
  if (!city) return { error: "city is required" };

  const shops = await Shop.find({ city: cityRegex(city) })
    .select("name city state items")
    .lean();

  return {
    results: shops.map((s) => ({
      shopName: s.name,
      city: s.city,
      state: s.state,
      menuItemCount: s.items?.length || 0,
    })),
  };
}

async function getOrderStatus({ orderId }, context) {
  if (!context?.userId) return { error: "User must be signed in to check order status" };
  if (!orderId) return { error: "orderId is required" };

  let order;
  try {
    order = await Order.findById(orderId)
      .populate("shopOrders.shop", "name")
      .lean();
  } catch {
    return { error: "Invalid order ID" };
  }

  if (!order || order.user.toString() !== context.userId) {
    return { error: "Order not found" };
  }

  return {
    orderId: order._id.toString(),
    paymentMethod: order.paymentMethod,
    paid: order.payment,
    placedAt: order.createdAt,
    shops: order.shopOrders.map((so) => ({
      shopName: so.shop?.name,
      status: so.status,
      itemCount: so.items?.length || 0,
      subtotal: so.subtotal,
    })),
  };
}

async function getOrderHistory({ limit }, context) {
  if (!context?.userId) return { error: "User must be signed in to view order history" };

  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10);

  const orders = await Order.find({ user: context.userId })
    .populate("shopOrders.shop", "name")
    .sort({ createdAt: -1 })
    .limit(cappedLimit)
    .lean();

  return {
    results: orders.map((o) => ({
      orderId: o._id.toString(),
      placedAt: o.createdAt,
      totalAmount: o.totalAmount,
      paid: o.payment,
      shops: o.shopOrders.map((so) => ({
        shopName: so.shop?.name,
        status: so.status,
        items: so.items?.map((it) => it.name) || [],
      })),
    })),
  };
}

const TOOL_EXECUTORS = {
  compareItemPrices,
  searchMenuItems,
  getShopsInCity,
  getOrderStatus,
  getOrderHistory,
};

// Runs a tool the model asked for. `context` carries server-verified request
// state (currently just userId) — tool implementations use it to scope
// order-related queries to the caller's own data instead of trusting
// anything the model supplies as an argument.
export const runTool = async (name, args, context) => {
  const executor = TOOL_EXECUTORS[name];
  if (!executor) return { error: `Unknown tool: ${name}` };
  try {
    return await executor(args || {}, context);
  } catch (err) {
    return { error: "Tool execution failed" };
  }
};
