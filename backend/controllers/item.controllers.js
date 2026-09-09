import uploadOnCloudinary from "../config/cloudinary.js";
import Item from "../models/item.model.js";
import Shop from "../models/shop.model.js";
import { parsePagination, applyPagination } from "../utils/pagination.js";
import { getCache, setCache, invalidatePattern } from "../config/redis.js";
import { semanticSearchItems } from "../services/embedding.service.js";


export const addItem = async (req, res) => {
  try {
    const { 
      name, 
      category, 
      type, 
      price,
      description,
      availability
    } = req.body;
    
    const shop = await Shop.findOne({ owner: req.userId });
    if (!shop) {
      return res.status(404).json({
        message: "No shop found for this account. Please create a shop first."
      });
    }
    
    let image;

    if (req.file) {
      image = await uploadOnCloudinary(req.file.path);
    } else {
      return res.status(400).json({ message: "Image is required" });
    }

    const item = await Item.create({
      name,
      category,
      type,
      image,
      price,
      shop: shop._id,
      description: description || "",
      availability: availability !== "false"
    });

    shop.items.push(item._id);

    await shop.save();

    await shop.populate({
      path: "items",
      options: { sort: { createdAt: -1 } },
    });

    await item.populate("shop");

    // Invalidate items and shops caches
    await invalidatePattern("items:*");
    await invalidatePattern("shops:*");

    return res.status(201).json({
      shop,
      item,
    });

  } catch (error) {
    console.error("Add Item error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const getItemsByShop = async (req, res) => {
  try {
    const { shopId } = req.params;
    const cacheKey = `items:shop:${shopId}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const items = await Item.find({ shop: shopId });
    
    if (!items.length) {
      return res.status(400).json({ message: "This shop does not have food items" });
    }

    await setCache(cacheKey, items, 180);
    return res.status(200).json(items);
  } catch (error) {
    console.error("Get item error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const getItemsByCity = async (req, res) => {
  try {
    const city = req.params.city;
    // e.g., ?city=Mumbai
    if (!city) {
      return res.status(400).json({ message: "City is required" });
    }

    const pagination = parsePagination(req.query);
    const normalizedCity = city.toLowerCase().trim();
    const cacheKey = `items:city:${normalizedCity}:p${pagination?.page || 1}:l${pagination?.limit || 20}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    // Find all active shops in this city
    const shopsInCity = await Shop.find({
      city: { $regex: new RegExp(`^${city}$`, "i") },
    });

    if (!shopsInCity.length) {
      return res.status(404).json({ message: "No shops found in this city" });
    }

    const shopIds = shopsInCity.map((shop) => shop._id);

    // Find items for these shops
    const items = await applyPagination(
      Item.find({
        shop: { $in: shopIds },
        availability: true,
      }),
      pagination
    );

    await setCache(cacheKey, items, 180);
    return res.status(200).json(items);
  } catch (error) {
    return res.status(500).json({ message: "Server error" });
  }
};


export const getItemById = async (req, res) => {
  try {
    const { itemId } = req.params;
    const cacheKey = `items:id:${itemId}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const item = await Item.findById(itemId).populate("shop", "name city address");
    
    if (!item) {
      return res.status(400).json({ message: "Item not found" });
    }

    await setCache(cacheKey, item, 300);
    return res.status(200).json(item);
  } catch (error) {
    console.error("Get item error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const editItem = async (req, res) => {
  try {
    const {
      name,
      category,
      type,
      price,
      description,
      availability
    } = req.body;
    const { itemId } = req.params;

    let image;
    if (req.file) {
      image = await uploadOnCloudinary(req.file.path);
    }

    const updateData = {
      name,
      category,
      type,
      price,
      description: description || "",
      ...(availability !== undefined && { availability: availability !== "false" })
    };

    if (image) {
      updateData.image = image;
    }

    const item = await Item.findByIdAndUpdate(
      itemId,
      updateData,
      { new: true }
    );

    if (!item) {
      return res.status(400).json({ message: "Item not found" });
    }

    await item.populate("shop");

    // Invalidate item and shop query caches
    await invalidatePattern("items:*");
    await invalidatePattern("shops:*");

    // --- Real-time emit for availability update ---
    const io = req.app.get("io");
    if (io) {
      io.emit("item:availabilityUpdated", {
        itemId: item._id,
        availability: item.availability,
        shopId: item.shop?._id,
        city: item.shop?.city,
      });
    }

    return res.status(200).json(item);
  } catch (error) {
    console.error("Edit item error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const deleteItem = async (req, res) => {
  try {
    const { itemId } = req.params;
    const item = await Item.findByIdAndDelete(itemId);
    
    if (!item) {
      return res.status(400).json({ message: "Item not found" });
    }

    const shop = await Shop.findOne({ owner: req.userId });

    shop.items = shop.items.filter((i) => i !== item._id);
    
    await shop.save();
    
    await shop.populate({
      path: "items",
      options: { sort: { createdAt: -1 } },
    });

    // Invalidate item and shop query caches
    await invalidatePattern("items:*");
    await invalidatePattern("shops:*");

    return res.status(201).json({
      shop,
      item,
    });

  } catch (error) {
    console.error("Delete item error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


/**
 * Semantic Vector Search (RAG) for Food Items
 * GET /api/item/search/semantic?query=...&city=...&maxPrice=...&type=...
 */
export const searchItemsSemantic = async (req, res) => {
  try {
    const { query, city, maxPrice, type, limit } = req.query;

    if (!city) {
      return res.status(400).json({ success: false, message: "City parameter is required" });
    }

    const searchResults = await semanticSearchItems({
      query: query || "",
      city,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      type,
      limit: limit ? parseInt(limit, 10) : 10,
    });

    return res.status(200).json({
      success: true,
      ...searchResults,
    });
  } catch (error) {
    console.error("Semantic search error:", error);
    return res.status(500).json({ success: false, message: "Semantic search failed" });
  }
};

