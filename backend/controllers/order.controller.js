import { sendOtpToUser, sendOrderConfirmationToCustomer, sendOrderNotificationToOwner } from "../config/mail.js";
import dotenv from "dotenv"
dotenv.config()
import DeliveryAssignment from "../models/deliveryAssignment.model.js";
import Order from "../models/order.model.js";
import Shop from "../models/shop.model.js";
import User from "../models/user.model.js";
import Razorpay from "razorpay"
import { runWithTransaction } from "../utils/transaction.js";

// Built lazily (not at module load): this file is imported before index.js's
// dotenv.config() runs, so process.env.RAZORPAY_KEY_ID would be undefined at
// module-load time, and the Razorpay SDK throws synchronously on a missing
// key_id — that crashed the entire server on startup, not just this feature.
let instance = null;
const getRazorpayInstance = () => {
  if (!instance) {
    instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return instance;
};



export const placeOrder = async (req, res) => {
  try {
    const { cartItems, address, paymentMethod } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }

    if (!address || !address.text || !address.latitude || !address.longitude) {
      return res.status(400).json({
        success: false,
        message: "Address (text, latitude, longitude) is required",
      });
    }

    // Group items by shop
    const groupedByShop = {};
    cartItems.forEach((item) => {
      const shopId = item.shop;
      if (!groupedByShop[shopId]) {
        groupedByShop[shopId] = [];
      }
      groupedByShop[shopId].push(item);
    });

    // Shop Orders banao
    const shopOrders = await Promise.all(
      Object.keys(groupedByShop).map(async (shopId) => {
        const shop = await Shop.findById(shopId).populate("owner");
        if (!shop) throw new Error(`Shop not found: ${shopId}`);

        const items = groupedByShop[shopId];
        const subtotal = items.reduce(
          (sum, i) => sum + Number(i.price) * Number(i.quantity),0);

        return {
          shop: shop._id,
          owner: shop.owner._id,
          items: items.map((i) => ({
            item: i.id,
            name: i.name,
            price: Number(i.price),
            quantity: Number(i.quantity),
          })),
          subtotal,
          status: "pending",
        };
      })
    );

    // Total + Delivery Fee
    // Threshold must match CartPage/CheckoutPage's free-delivery cutoff (1000),
    // otherwise what the customer is shown and what they're charged diverge.
    const subtotal = shopOrders.reduce((sum, so) => sum + so.subtotal, 0);
    const deliveryFee = subtotal < 1000 ? 40 : 0;
    let totalAmount = subtotal + deliveryFee;

    console.log(" Total Amount to charge:", totalAmount);

    let newOrder;

    // Online Payment (Razorpay)
    if (paymentMethod === "online") {
      const razorOrder = await getRazorpayInstance().orders.create({
        amount: Math.round(totalAmount * 100), // paise me (integer hona chahiye)
        currency: "INR",
        receipt: `receipt_${Date.now()}`,
      });

      await runWithTransaction(async (session) => {
        const orderData = {
          user: req.userId,
          address,
          paymentMethod,
          totalAmount,
          deliveryFee,
          shopOrders,
          razorpayOrderId: razorOrder.id,
          payment: false,
        };
        const created = session
          ? await Order.create([orderData], { session })
          : [await Order.create(orderData)];
        newOrder = created[0];
      });

      return res.status(200).json({
        success: true,
        razorOrder,
        orderId: newOrder._id,
        key: process.env.RAZORPAY_KEY_ID,
      });
    }

    // COD Order (Atomic order creation + user order list update)
    await runWithTransaction(async (session) => {
      const orderData = {
        user: req.userId,
        address,
        paymentMethod,
        totalAmount,
        deliveryFee,
        shopOrders,
        payment: false,
      };
      const created = session
        ? await Order.create([orderData], { session })
        : [await Order.create(orderData)];
      newOrder = created[0];

      if (session) {
        await User.findByIdAndUpdate(
          req.userId,
          { $push: { orders: newOrder._id } },
          { session }
        );
      } else {
        const user = await User.findById(req.userId);
        if (user) {
          user.orders.push(newOrder._id);
          await user.save();
        }
      }
    });

    // Fetch fully populated order for socket emission and emails
    // Fetch fully populated order for socket emission
    const io = req.app.get("io");
    const populatedOrder = await Order.findById(newOrder._id)
      .populate("user", "fullName email mobile")
      .populate("shopOrders.shop", "name")
      .populate("shopOrders.items.item", "name price image");

    // Send emails to customer and shop owners
    try {
      // Send confirmation email to customer
      await sendOrderConfirmationToCustomer(populatedOrder.user, populatedOrder);
      console.log("✅ Customer email sent to:", populatedOrder.user.email);
      
      // Send notification email to each shop owner
      for (const shopOrder of populatedOrder.shopOrders) {
        const shop = await Shop.findById(shopOrder.shop._id).populate("owner", "fullName email");
        console.log("📦 Shop:", shop?.name, "| Owner:", shop?.owner ? `${shop.owner.fullName} (${shop.owner.email})` : "NOT FOUND");
        
        if (shop && shop.owner && shop.owner.email) {
          await sendOrderNotificationToOwner(shop.owner, populatedOrder, shopOrder);
          console.log("✅ Owner email sent to:", shop.owner.email);
        } else {
          console.log("⚠️ Skipping - No owner email available");
        }
      }
      
      console.log("✅ All order emails processed");
    } catch (emailError) {
      console.error("⚠️ Failed to send order emails:", emailError.message);
      console.error("Stack:", emailError.stack);
      // Don't fail the order if email fails
    }

    // Emit socket events
    if (io) {
      populatedOrder.shopOrders.forEach(shopOrder => {
        io.emit("orders:new", {
          ownerId: shopOrder.owner.toString(),
          order: {
            _id: populatedOrder._id,
            user: populatedOrder.user,
            address: populatedOrder.address,
            paymentMethod: populatedOrder.paymentMethod,
            createdAt: populatedOrder.createdAt,
            shopOrder,
          },
        });
      });
    }

    return res.status(201).json({ success: true, order: newOrder });
  } catch (error) {
    console.error("❌ Place order error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const verifyRazorpay = async (req, res) => {
  try {
    const { razorpay_payment_id, orderId } = req.body;

    if (!razorpay_payment_id || !orderId) {
      return res.status(400).json({ success: false, message: "razorpay_payment_id and orderId are required" });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    // Only the order's own owner can confirm its payment
    if (order.user.toString() !== req.userId) {
      return res.status(403).json({ success: false, message: "Not authorized for this order" });
    }

    if (order.paymentMethod !== "online") {
      return res.status(400).json({ success: false, message: "Order is not an online payment order" });
    }

    // Already verified — avoid double-processing (double emails, duplicate socket events)
    if (order.payment) {
      return res.status(200).json({ success: true, message: "Payment already verified" });
    }

    const payment = await getRazorpayInstance().payments.fetch(razorpay_payment_id);

    if (!payment || payment.status !== "captured") {
      return res.status(400).json({ success: false, message: "Payment failed or not captured" });
    }

    // Tie the captured payment back to THIS order's own Razorpay order and amount,
    // so a payment captured for one order can't be replayed to mark a different order as paid.
    if (payment.order_id !== order.razorpayOrderId) {
      return res.status(400).json({ success: false, message: "Payment does not match this order" });
    }

    if (payment.amount !== Math.round(order.totalAmount * 100)) {
      return res.status(400).json({ success: false, message: "Payment amount mismatch" });
    }

    const existingWithPayment = await Order.findOne({ razorpayPaymentId: razorpay_payment_id });
    if (existingWithPayment && existingWithPayment._id.toString() !== order._id.toString()) {
      return res.status(400).json({ success: false, message: "Payment already used for another order" });
    }

    await runWithTransaction(async (session) => {
      order.payment = true;
      order.razorpayPaymentId = razorpay_payment_id;
      order.shopOrders.forEach(shopOrder => {
        shopOrder.status = "pending";
      });

      if (session) {
        await order.save({ session });
        await User.findByIdAndUpdate(
          order.user,
          { $addToSet: { orders: order._id } },
          { session }
        );
      } else {
        await order.save();
        const user = await User.findById(order.user);
        if (user && !user.orders.includes(order._id)) {
          user.orders.push(order._id);
          await user.save();
        }
      }
    });

    // Fetch fully populated order for socket emission and emails
    const io = req.app.get("io");
    const populatedOrder = await Order.findById(order._id)
      .populate("user", "fullName email mobile")
      .populate("shopOrders.shop", "name")
      .populate("shopOrders.items.item", "name price image");

    // Send emails to customer and shop owners
    try {
      await sendOrderConfirmationToCustomer(populatedOrder.user, populatedOrder);
      console.log("✅ Customer email sent to:", populatedOrder.user.email);

      for (const shopOrder of populatedOrder.shopOrders) {
        const shop = await Shop.findById(shopOrder.shop._id).populate("owner", "fullName email");
        console.log("📦 Shop:", shop?.name, "| Owner:", shop?.owner ? `${shop.owner.fullName} (${shop.owner.email})` : "NOT FOUND");

        if (shop && shop.owner && shop.owner.email) {
          await sendOrderNotificationToOwner(shop.owner, populatedOrder, shopOrder);
          console.log("✅ Owner email sent to:", shop.owner.email);
        } else {
          console.log("⚠️ Skipping - No owner email available");
        }
      }

      console.log("✅ All order emails processed");
    } catch (emailError) {
      console.error("⚠️ Failed to send order emails:", emailError.message);
      console.error("Stack:", emailError.stack);
    }

    // Emit socket events
    if (io) {
      populatedOrder.shopOrders.forEach(shopOrder => {
        io.emit("orders:new", {
          ownerId: shopOrder.owner.toString(),
          order: {
            _id: populatedOrder._id,
            user: populatedOrder.user,
            address: populatedOrder.address,
            paymentMethod: populatedOrder.paymentMethod,
            createdAt: populatedOrder.createdAt,
            shopOrder,
          },
        });
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully",
      order,
    });
  } catch (error) {
    console.error("Verify Razorpay Error:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.userId })
      .sort({ createdAt: -1 })
      .populate("shopOrders.shop", "name")
      .populate("shopOrders.owner", "name email mobile")
      .populate("shopOrders.items.item", "name price image");

  return  res.json({ success: true, orders });
  } catch (error) {
    console.error("Error fetching my orders:", error);
   return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const getOwnerOrders = async (req, res) => {
  try {
    const ownerId = req.userId; // from isAuth middleware

    // 1️⃣ Find all orders where this owner has shopOrders
    const orders = await Order.find({ "shopOrders.owner": ownerId })
      .sort({ createdAt: -1 })
      .populate("user", "fullName email mobile")      // customer info
      .populate("shopOrders.shop", "name")            // shop info
      .populate(
        "shopOrders.items.item",
        "name price image"                            // IMAGE ALWAYS
      )
      .populate(
        "shopOrders.assignedDeliveryBoy",
        "fullName mobile"
      )
      .populate(
        "shopOrders.deliveredBy",
        "fullName mobile"
      );

    // 2️⃣ Extract only the shopOrder that belongs to this owner
    const filteredOrders = orders.map((order) => {
      const shopOrder = order.shopOrders.find(
        (so) => so.owner.toString() === ownerId.toString()
      );

      return {
        _id: order._id,
        user: order.user,
        address: order.address,
        paymentMethod: order.paymentMethod,
        createdAt: order.createdAt,
        shopOrder, // populated shopOrder (items + image intact)
      };
    });

    return res.json({
      success: true,
      orders: filteredOrders,
    });

  } catch (error) {
    console.error("Get owner orders error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};



export const updateOwnerOrderStatus = async (req, res) => {
  try {
    const { orderId, shopId } = req.params;
    const { status } = req.body;

    /* ---------------- Find Order ---------------- */
    let order = await Order.findById(orderId)
      .populate("shopOrders.shop", "name")
      .populate("shopOrders.items.item", "name price image")
      .populate("shopOrders.assignedDeliveryBoy", "fullName name mobile");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const shopOrder = order.shopOrders.find(
      (so) => so.shop._id.toString() === shopId
    );

    if (!shopOrder) {
      return res.status(404).json({
        success: false,
        message: "Shop order not found",
      });
    }

    /* ---------------- Update Status ---------------- */
    shopOrder.status = status;

    let deliveryBoysPayload = [];
    let assignment = null;

    /* ---------------- OUT FOR DELIVERY ---------------- */
    if (status === "out_for_delivery" && !shopOrder.assignedDeliveryBoy) {
      const { longitude, latitude } = order.address || {};

      console.log("🚚 OUT FOR DELIVERY - Finding delivery boys...");
      console.log("📍 Order address coords:", { longitude, latitude });

      // First, find ALL delivery boys to debug
      const allDeliveryBoys = await User.find({ role: "deliveryBoy" })
        .select("_id fullName isOnline socketId location");
        console.log("👥 All delivery boys in DB:", allDeliveryBoys.map(b => ({
        id: b._id,
        name: b.fullName,
        isOnline: b.isOnline,
        hasSocket: !!b.socketId,
        location: b.location?.coordinates || "NO LOCATION"
      })));

      if (
        Number.isFinite(Number(longitude)) &&
        Number.isFinite(Number(latitude))
      ) {
        const nearby = await User.find({
          role: "deliveryBoy",
          isOnline: true,
          socketId: { $ne: null },
          location: {
            $near: {
              $geometry: {
                type: "Point",
                coordinates: [Number(longitude), Number(latitude)],
              },
              $maxDistance: 10000, // 10km radius for finding delivery boys
            },
          },
        }).select("_id fullName mobile socketId location");

        console.log(" Nearby delivery boys (within 10km, online, with socket):", nearby.length);

        const nearbyIds = nearby.map((b) => b._id);

        const busyIds = await DeliveryAssignment.find({
          assignedTo: { $in: nearbyIds },
          status: { $nin: ["delivered", "completed", "cancelled", "expired"] },
        }).distinct("assignedTo");

        const busySet = new Set(busyIds.map(String));

        const availableBoys = nearby.filter(
          (b) => !busySet.has(String(b._id))
        );

        if (availableBoys.length === 0) {
          await order.save();
          
          // Re-fetch for socket emit
          const refetchedOrder = await Order.findById(orderId)
            .populate("shopOrders.shop", "name")
            .populate("shopOrders.items.item", "name price image")
            .populate("shopOrders.assignedDeliveryBoy", "fullName name mobile");
          
          const refetchedShopOrder = refetchedOrder.shopOrders.find(
            (so) => so.shop._id.toString() === shopId
          );

          // EMIT SOCKET BEFORE RETURNING (so user gets update!)
          const io = req.app.get("io");
          if (io) {
            io.emit("orders:statusUpdated", {
              orderId: refetchedOrder._id,
              shopOrder: refetchedShopOrder,
            });
          }

          return res.json({
            success: true,
            message: "Order updated but no delivery boys available",
            shopOrder: refetchedShopOrder,
            deliveryBoys: [],
          });
        }

        assignment = await DeliveryAssignment.create({
          order: order._id,
          shop: shopOrder.shop,
          shopOrderId: shopOrder._id,
          broadcastedTo: availableBoys.map((b) => b._id),
          status: "broadcasted",
        });

        shopOrder.assignment = assignment._id;
        shopOrder.deliveryBoyLocation = undefined;

        deliveryBoysPayload = availableBoys.map((b) => ({
          id: b._id,
          name: b.fullName,
          mobile: b.mobile,
          socketId: b.socketId,
          latitude: b.location?.coordinates?.[1] ?? null,
          longitude: b.location?.coordinates?.[0] ?? null,
        }));

        const io = req.app.get("io");
        if (io) {
          availableBoys.forEach((b) => {
            if (b.socketId) {
              io.to(b.socketId).emit("delivery:newAssignment", {
                assignmentId: assignment._id,
                orderId: order._id,
                shopId,
                shopName: shopOrder.shop.name,
                address: order.address,
                items: shopOrder.items.map((i) => ({
                  name: i.name,
                  qty: i.quantity,
                  price: i.price,
                  image: i.item?.image,
                })),
                subtotal: shopOrder.subtotal,
              });
            }
          });
        }
      }
    }

    /* ---------------- Save Order ---------------- */
    await order.save();

    /* ---------------- Re-fetch (CRITICAL) ---------------- */
    order = await Order.findById(orderId)
      .populate("shopOrders.shop", "name")
      .populate("shopOrders.items.item", "name price image") 
      .populate("shopOrders.assignedDeliveryBoy", "fullName name mobile");

    const updatedShopOrder = order.shopOrders.find(
      (so) => so.shop._id.toString() === shopId
    );

    /* ---------------- Socket Emit ---------------- */
    const io = req.app.get("io");
    if (io) {
      io.emit("orders:statusUpdated", {
        orderId: order._id,
        shopOrder: updatedShopOrder,
      });
    }

    /* ---------------- Response ---------------- */
    return res.json({
      success: true,
      message: "Order status updated successfully",
      shopOrder: updatedShopOrder,
      assignmentId: assignment?._id || updatedShopOrder.assignment || null,
      deliveryBoys: deliveryBoysPayload,
      deliveryBoy: updatedShopOrder.assignedDeliveryBoy || null,
    });

  } catch (error) {
    console.error("Update order status error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};





export const getDeliveryBoyAssignments = async (req, res) => {
  try {
    const deliveryBoyId = req.userId; // token se niklega
    console.log("🚚 Fetching assignments for delivery boy:", deliveryBoyId);

    const assignments = await DeliveryAssignment.find({
      broadcastedTo: deliveryBoyId,
      status: "broadcasted",
    })
      .populate("order")
      .populate("shop");

    console.log("📦 Found assignments:", assignments.length);

    // filter only useful info (skip if order is null)
    const formatted = assignments
      .filter(a => a.order != null) // Skip if order was deleted
      .map(a => ({
        assignmentId: a._id,
        orderId: a.order._id,
        shopName: a.shop?.name || "Unknown Shop",
        address: a.order.address,
        items: a.order.shopOrders?.find(so => so._id.equals(a.shopOrderId))?.items || [],
        subtotal: a.order.shopOrders?.find(so => so._id.equals(a.shopOrderId))?.subtotal || 0
      }));

    return res.json({ 
      success: true, 
      assignments: formatted 
    });

  } catch (error) {
    console.error("Get delivery boy assignments error:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Something went wrong. Please try again." });
  }
};



export const acceptAssignment = async (req, res) => {
  try {
    const { assignmentId } = req.params;
    const userId = req.userId;

    const assignment = await DeliveryAssignment.findById(assignmentId);
    if (!assignment) {
      return res.status(404).json({ success: false, message: "Assignment not found" });
    }

    if (assignment.status !== "broadcasted") {
      return res.status(400).json({ success: false, message: "Assignment already taken/expired" });
    }

    // Do not allow accepting if rider already has an active assignment
    const alreadyActive = await DeliveryAssignment.findOne({
      assignedTo: userId,
      status: { $nin: ["delivered", "completed", "cancelled"] }
    });

    if (alreadyActive) {
      return res.status(400).json({ success: false, message: "You already have an active order" });
    }

    // update assignment
    assignment.status = "assigned";
    assignment.assignedTo = userId;
    assignment.acceptedAt = new Date();
    await assignment.save();

    // update order shopOrder
    const order = await Order.findById(assignment.order);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const shopOrder = order.shopOrders.id(assignment.shopOrderId);
    if (!shopOrder) {
      return res.status(404).json({ success: false, message: "ShopOrder not found" });
    }

    shopOrder.assignedDeliveryBoy = userId;
    shopOrder.status = "out_for_delivery";


    // seed initial deliveryBoyLocation from rider's last known user.location (if exists)
    const boy = await User.findById(userId).select("fullName mobile location");
    if (boy?.location?.coordinates?.length === 2) {
      shopOrder.deliveryBoyLocation = {
        lat: Number(boy.location.coordinates[1]),
        lng: Number(boy.location.coordinates[0]),
      };
    } else {
      // leave undefined/null – don't put 0,0
      shopOrder.deliveryBoyLocation = undefined;
    }

    await order.save();

    // Notify shop owner that delivery boy has accepted
    const io = req.app.get("io");
    if (io) {
      io.emit("delivery:accepted", {
        orderId: order._id,
        shopOrderId: shopOrder._id,
        shopId: assignment.shop,
        deliveryBoy: {
          _id: userId,
          fullName: boy?.fullName,
          mobile: boy?.mobile,
        },
      });
    }

    return res.json({
      success: true,
      message: "Order assigned successfully",
      assignmentId,
      orderId: order._id,
      shopId: assignment.shop,
      deliveryBoy: { fullName: boy?.fullName, mobile: boy?.mobile },
    });
  } catch (err) {
    console.error("Accept assignment error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};



export const getCurrentOrder = async (req, res) => {
  try {
    const assignment = await DeliveryAssignment.findOne({
      assignedTo: req.userId,
      status: "assigned",
    })
      .populate({
        path: "order",
        populate: [{ path: "user", select: "fullName mobile email" }],
      })
      .populate("shop")
      .populate("assignedTo", "fullName mobile location");

    /* ---------------- No Active Order ---------------- */
    if (!assignment) {
      return res.json({ success: true, order: null });
    }

    const order = assignment.order;
    if (!order || !Array.isArray(order.shopOrders)) {
      return res.status(404).json({
        success: false,
        message: "Order data corrupted",
      });
    }

    const shopOrder = order.shopOrders.find(
      (so) => String(so._id) === String(assignment.shopOrderId)
    );

    if (!shopOrder) {
      return res.json({
        success: false,
        message: "Shop order not found",
      });
    }

    /* ---------------- Delivery Boy Location ---------------- */
    let deliveryBoyLocation = null;

    if (assignment.assignedTo?.location?.coordinates?.length === 2) {
      const [lng, lat] = assignment.assignedTo.location.coordinates.map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        deliveryBoyLocation = { lat, lng };
      }
    } else if (
      shopOrder.deliveryBoyLocation?.lat &&
      shopOrder.deliveryBoyLocation?.lng
    ) {
      deliveryBoyLocation = {
        lat: Number(shopOrder.deliveryBoyLocation.lat),
        lng: Number(shopOrder.deliveryBoyLocation.lng),
      };
    }

    /* ---------------- Customer Location ---------------- */
    const customer =
      Number.isFinite(Number(order.address?.latitude)) &&
      Number.isFinite(Number(order.address?.longitude))
        ? {
            lat: Number(order.address.latitude),
            lng: Number(order.address.longitude),
          }
        : null;

    return res.json({
      success: true,
      order: {
        _id: order._id,
        user: order.user,
        address: order.address,
        shopOrder,
        deliveryBoyLocation,
        customer,
      },
    });

  } catch (error) {
    console.error("❌ Get current order error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
};



export const updateDeliveryBoyLocation = async (req, res) => {
  try {
    const { longitude, latitude, orderId, shopOrderId } = req.body;

    const lon = Number(longitude);
    const lat = Number(latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return res.status(400).json({ success: false, message: "Valid longitude & latitude required" });
    }

    // 1) Update rider's user doc
    await User.findByIdAndUpdate(req.userId, {
      location: { type: "Point", coordinates: [lon, lat] },
    });

    // 2) Also update in the specific shopOrder (if IDs present)
    if (orderId && shopOrderId) {
      const order = await Order.findById(orderId);
      if (order) {
        const shopOrder = order.shopOrders.id(shopOrderId);
        if (shopOrder) {
          shopOrder.deliveryBoyLocation = { lat, lng: lon };
          await order.save();
        }
      }
    }

    // 3) Emit live update
    const io = req.app.get("io");
    if (io) {
      io.emit("delivery:locationUpdate", {
        deliveryBoyId: req.userId,
        longitude: lon,
        latitude: lat,
        orderId,
        shopOrderId
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Location update error:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};




export const myLocation= async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user || !user.location) {
      return res.json({ success: false, message: "Location not found" });
    }
    res.json({ success: true, location: user.location });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};



export const getOrderById = async (req, res) => {
  const { orderId } = req.params;

  try {
    const order = await Order.findById(orderId)
      .populate("user") // customer
      .populate({
        path: "shopOrders.shop",
        model: "Shop",
      })
      .populate({
        path: "shopOrders.assignedDeliveryBoy",
        model: "User",
      })
      .populate({
        path: "shopOrders.items.item",
        model: "Item",
      })
      .lean();

    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    res.json({ success: true, order });
  } catch (error) {
    console.error("Error fetching order:", error);
    res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};



export const getDeliveryBoyLocation = async (req, res) => {
  const { orderId, shopOrderId } = req.params;

  try {
    const order = await Order.findById(orderId)
      .populate("shopOrders.assignedDeliveryBoy", "fullName mobile location")
      .exec();

    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const shopOrder = order.shopOrders.id(shopOrderId);
    if (!shopOrder) {
      return res.status(404).json({ success: false, message: "Shop order not found" });
    }

    const dest =
      order.address && Number.isFinite(Number(order.address.latitude)) && Number.isFinite(Number(order.address.longitude))
        ? { latitude: Number(order.address.latitude), longitude: Number(order.address.longitude) }
        : null;

    // Prefer shopOrder.deliveryBoyLocation, else user's last known location
    let deliveryBoyLocation = null;
    if (shopOrder.deliveryBoyLocation) {
      const lat = Number(shopOrder.deliveryBoyLocation.lat);
      const lng = Number(shopOrder.deliveryBoyLocation.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        deliveryBoyLocation = { lat, lng };
      }
    } else if (shopOrder.assignedDeliveryBoy?.location?.coordinates?.length === 2) {
      const [lng, lat] = shopOrder.assignedDeliveryBoy.location.coordinates.map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        deliveryBoyLocation = { lat, lng };
      }
    }

    return res.json({
      success: true,
      deliveryBoyLocation, // may be null (frontend handles this)
      destination: dest,   // { latitude, longitude } or null
      deliveryBoyAvailable: Boolean(deliveryBoyLocation)
    });
  } catch (err) {
    console.error("Error fetching delivery boy location:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};



// Step 1: Send OTP
export const sendDeliveryOtp = async (req, res) => {
  try {
    const { orderId, shopOrderId } = req.body;
    
    if (!orderId || !shopOrderId) {
      return res.status(400).json({ success: false, message: "Order ID and Shop Order ID required" });
    }

    const order = await Order.findById(orderId).populate("user");
    
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const shopOrder = order.shopOrders.id(shopOrderId);

    if (!shopOrder) {
      return res.status(404).json({ success: false, message: "Shop order not found" });
    }

    if (!order.user || !order.user.email) {
      return res.status(400).json({ success: false, message: "User email not found" });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000);

    // Save OTP in DB temporarily
    shopOrder.deliveryOtp = otp;
    shopOrder.otpExpiresAt = Date.now() + 5 * 60 * 1000; // 5 min expiry
    await order.save();

    // Send OTP to user via Email
    try {
      await sendOtpToUser(order.user, otp);
      console.log(`OTP ${otp} sent to ${order.user.email}`);
    } catch (emailError) {
      console.error("Email sending failed:", emailError);
      // Still return success since OTP is saved - user can ask delivery boy to verify manually
      return res.json({
        success: true,
        message: `OTP generated. Email delivery may be delayed.`,
        otp: process.env.NODE_ENV !== "production" ? otp : undefined // Only show OTP in dev
      });
    }

    return res.json({
      success: true,
      message: `OTP sent to ${order.user.fullName}`,
    });
  } catch (err) {
    console.error("Send OTP Error:", err);
    res.status(500).json({ success: false, message: `Failed to send OTP: ${err.message}` });
  }
};



export const verifyDeliveryOtp = async (req, res) => {
  try {
    const { orderId, shopOrderId, otp } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const shopOrder = order.shopOrders.id(shopOrderId);
    if (!shopOrder) {
      return res.status(404).json({ success: false, message: "Shop order not found" });
    }

    // OTP check
    if (
      !shopOrder.deliveryOtp ||
      String(shopOrder.deliveryOtp) !== String(otp) ||
      !shopOrder.otpExpiresAt ||
      shopOrder.otpExpiresAt < Date.now()
    ) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }

    // MARK DELIVERED
    shopOrder.status = "delivered";
    shopOrder.deliveredAt = new Date();
    shopOrder.deliveredBy = shopOrder.assignedDeliveryBoy; // STORE WHO DELIVERED before clearing
    shopOrder.deliveryOtp = null;
    shopOrder.otpExpiresAt = null;

    // VERY IMPORTANT — FREE THE DELIVERY BOY
    shopOrder.assignedDeliveryBoy = null;
    shopOrder.assignment = null;
    shopOrder.deliveryBoyLocation = undefined;

    await order.save();

    // DELETE ASSIGNMENT
    await DeliveryAssignment.deleteMany({
      order: order._id,
      shopOrderId: shopOrder._id,
    });

    const io = req.app.get("io");
    if (io) {
      io.emit("delivery:completed", {
        orderId: order._id,
        shopOrderId: shopOrder._id,
      });
    }

    return res.json({
      success: true,
      message: "Order delivered successfully",
    });

  } catch (err) {
    console.error("Verify OTP Error:", err);
    res.status(500).json({ success: false, message: "Failed to verify OTP" });
  }
};




// GET /api/delivery/my-orders
export const getMyDeliveredOrders = async (req, res) => {
  try {
    const deliveryBoyId = req.userId; // login user
    console.log("📦 getMyDeliveredOrders for:", deliveryBoyId);

    const orders = await Order.find({
      $or: [
        { "shopOrders.deliveredBy": deliveryBoyId },
        { "shopOrders.assignedDeliveryBoy": deliveryBoyId, "shopOrders.status": "delivered" }
      ]
    })
      .populate("shopOrders.shop")
      .populate("shopOrders.deliveredBy", "fullName mobile")
      .populate("user")
      .sort({ createdAt: -1 });

    console.log("📦 Raw orders found:", orders.length);
    orders.forEach(o => {
      o.shopOrders.forEach(so => {
        console.log("  - ShopOrder:", so._id, "status:", so.status, "deliveredBy:", so.deliveredBy, "assignedDeliveryBoy:", so.assignedDeliveryBoy);
      });
    });

    // Filter to only include shopOrders delivered by this delivery boy
    const filteredOrders = orders.map(order => {
      const relevantShopOrders = order.shopOrders.filter(so => 
        (so.deliveredBy && so.deliveredBy._id?.toString() === deliveryBoyId.toString()) ||
        (so.assignedDeliveryBoy?.toString() === deliveryBoyId.toString() && so.status === "delivered")
      );
      return { ...order.toObject(), shopOrders: relevantShopOrders };
    }).filter(order => order.shopOrders.length > 0);

    console.log("📦 Filtered orders:", filteredOrders.length);
    return res.json({ success: true, orders: filteredOrders });
  } catch (err) {
    console.error("Get My Orders Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
};



export const getTodayStats = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // Find orders where this delivery boy delivered
    const orders = await Order.find({
      $or: [
        { "shopOrders.deliveredBy": deliveryBoyId },
        { "shopOrders.assignedDeliveryBoy": deliveryBoyId, "shopOrders.status": "delivered" }
      ]
    }).lean();


    // Flatten and filter today's delivered orders by this delivery boy
    let todayDelivered = [];
    orders.forEach(order => {
      order.shopOrders.forEach(shopOrder => {
        const isDeliveredByMe = 
          (shopOrder.deliveredBy && String(shopOrder.deliveredBy) === String(deliveryBoyId)) ||
          (String(shopOrder.assignedDeliveryBoy) === String(deliveryBoyId) && shopOrder.status === "delivered");
        
        if (
          isDeliveredByMe &&
          shopOrder.status === "delivered" &&
          shopOrder.deliveredAt &&
          new Date(shopOrder.deliveredAt) >= startOfDay
        ) {
          todayDelivered.push(shopOrder);
        }
      });
    });

    // Hour wise group manually
    let stats = {};
    todayDelivered.forEach(shopOrder => {
      const hour = new Date(shopOrder.deliveredAt).getHours();
      stats[hour] = (stats[hour] || 0) + 1;
    });

    // object → array convert
    const formattedStats = Object.keys(stats).map(hour => ({
      hour: parseInt(hour),
      count: stats[hour]
    }));

    formattedStats.sort((a, b) => a.hour - b.hour);

    res.json({ success: true, stats: formattedStats });
  } catch (err) {
    console.error("Stats Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
};



export const getMonthStats = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;

    // Start of month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Current time
    const now = new Date();

    // Find orders where this delivery boy delivered
    const orders = await Order.find({
      $or: [
        { "shopOrders.deliveredBy": deliveryBoyId },
        { "shopOrders.assignedDeliveryBoy": deliveryBoyId, "shopOrders.status": "delivered" }
      ],
      "shopOrders.deliveredAt": { $gte: startOfMonth, $lte: now }
    }).lean();

    // Flatten and filter delivered orders by this delivery boy
    let monthDelivered = [];
    orders.forEach(order => {
      order.shopOrders.forEach(shopOrder => {
        const isDeliveredByMe = 
          (shopOrder.deliveredBy && String(shopOrder.deliveredBy) === String(deliveryBoyId)) ||
          (String(shopOrder.assignedDeliveryBoy) === String(deliveryBoyId) && shopOrder.status === "delivered");
        
        if (
          isDeliveredByMe &&
          shopOrder.status === "delivered" &&
          shopOrder.deliveredAt &&
          new Date(shopOrder.deliveredAt) >= startOfMonth
        ) {
          monthDelivered.push(shopOrder);
        }
      });
    });

    // Day-wise group made
    let stats = {};
    monthDelivered.forEach(shopOrder => {
      const date = new Date(shopOrder.deliveredAt);
      const day = date.getDate(); // Only get date from 1 to 31
      stats[day] = (stats[day] || 0) + 1;
    });

    // object → array convert
    const formattedStats = Object.keys(stats).map(day => ({
      day: parseInt(day),
      count: stats[day]
    }));

    // sort by day
    formattedStats.sort((a, b) => a.day - b.day);

    res.json({ success: true, stats: formattedStats });
  } catch (err) {
    console.error("Month Stats Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch monthly stats" });
  }
};


// PAYMENT CALCULATION ENDPOINTS
const BASE_PAY_PER_DELIVERY = 80;
const PEAK_HOUR_BONUS = 20;
const PEAK_HOURS = [12, 13, 19, 20, 21]; // 12-1pm, 7-9pm

const calculatePaymentWithBonuses = (deliveries, period) => {
  let basePayment = deliveries * BASE_PAY_PER_DELIVERY;
  let bonus = 0;

  // Milestone bonuses
  if (deliveries >= 10) bonus += 100;
  if (deliveries >= 20) bonus += 200;
  if (deliveries >= 30) bonus += 300;

  // Period-specific bonuses
  if (period === 'weekly' && deliveries >= 40) {
    bonus += 500;
  } else if (period === 'monthly') {
    if (deliveries >= 150) bonus += 2000;
    if (deliveries >= 180) bonus += 3000;
    if (deliveries >= 200) bonus += 5000;
  }

  return { basePayment, bonus, total: basePayment + bonus };
};

export const getDailyPayment = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    
    if (!deliveryBoyId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    console.log('getDailyPayment for deliveryBoyId:', deliveryBoyId);
    
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const orders = await Order.find({
      $or: [
        { "shopOrders.deliveredBy": deliveryBoyId },
        { "shopOrders.assignedDeliveryBoy": deliveryBoyId, "shopOrders.status": "delivered" }
      ]
    }).lean();

    console.log('Found orders:', orders.length);

    let todayDelivered = [];
    let peakHourDeliveries = 0;

    orders.forEach(order => {
      order.shopOrders.forEach(shopOrder => {
        const isDeliveredByMe = 
          (shopOrder.deliveredBy && String(shopOrder.deliveredBy) === String(deliveryBoyId)) ||
          (String(shopOrder.assignedDeliveryBoy) === String(deliveryBoyId) && shopOrder.status === "delivered");
        
        if (
          isDeliveredByMe &&
          shopOrder.status === "delivered" &&
          shopOrder.deliveredAt &&
          new Date(shopOrder.deliveredAt) >= startOfDay
        ) {
          todayDelivered.push(shopOrder);
          const hour = new Date(shopOrder.deliveredAt).getHours();
          if (PEAK_HOURS.includes(hour)) {
            peakHourDeliveries++;
          }
        }
      });
    });

    const deliveries = todayDelivered.length;
    const payment = calculatePaymentWithBonuses(deliveries, 'daily');
    
    // Add peak hour bonus
    const peakHourBonus = peakHourDeliveries * PEAK_HOUR_BONUS;
    payment.bonus += peakHourBonus;
    payment.total = payment.basePayment + payment.bonus;
    payment.peakHourDeliveries = peakHourDeliveries;
    payment.peakHourBonus = peakHourBonus;

    console.log('Daily payment response:', { deliveries, ...payment });

    res.json({ 
      success: true, 
      deliveries,
      basePayment: payment.basePayment,
      bonus: payment.bonus,
      total: payment.total,
      peakHourDeliveries: payment.peakHourDeliveries,
      peakHourBonus: payment.peakHourBonus
    });
  } catch (err) {
    console.error("Daily Payment Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch daily payment" });
  }
};

export const getWeeklyPayment = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    
    if (!deliveryBoyId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    console.log('getWeeklyPayment for deliveryBoyId:', deliveryBoyId);
    
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay()); // Start from Sunday
    startOfWeek.setHours(0, 0, 0, 0);

    const orders = await Order.find({
      $or: [
        { "shopOrders.deliveredBy": deliveryBoyId },
        { "shopOrders.assignedDeliveryBoy": deliveryBoyId, "shopOrders.status": "delivered" }
      ]
    }).lean();

    let weekDelivered = [];
    let peakHourDeliveries = 0;

    orders.forEach(order => {
      order.shopOrders.forEach(shopOrder => {
        const isDeliveredByMe = 
          (shopOrder.deliveredBy && String(shopOrder.deliveredBy) === String(deliveryBoyId)) ||
          (String(shopOrder.assignedDeliveryBoy) === String(deliveryBoyId) && shopOrder.status === "delivered");
        
        if (
          isDeliveredByMe &&
          shopOrder.status === "delivered" &&
          shopOrder.deliveredAt &&
          new Date(shopOrder.deliveredAt) >= startOfWeek
        ) {
          weekDelivered.push(shopOrder);
          const hour = new Date(shopOrder.deliveredAt).getHours();
          if (PEAK_HOURS.includes(hour)) {
            peakHourDeliveries++;
          }
        }
      });
    });

    const deliveries = weekDelivered.length;
    const payment = calculatePaymentWithBonuses(deliveries, 'weekly');
    
    // Add peak hour bonus
    const peakHourBonus = peakHourDeliveries * PEAK_HOUR_BONUS;
    payment.bonus += peakHourBonus;
    payment.total = payment.basePayment + payment.bonus;
    payment.peakHourDeliveries = peakHourDeliveries;
    payment.peakHourBonus = peakHourBonus;

    console.log('Weekly payment response:', { deliveries, ...payment });

    res.json({ 
      success: true, 
      deliveries,
      basePayment: payment.basePayment,
      bonus: payment.bonus,
      total: payment.total,
      peakHourDeliveries: payment.peakHourDeliveries,
      peakHourBonus: payment.peakHourBonus
    });
  } catch (err) {
    console.error("Weekly Payment Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch weekly payment" });
  }
};

export const getMonthlyPayment = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    
    if (!deliveryBoyId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    console.log('getMonthlyPayment for deliveryBoyId:', deliveryBoyId);
    
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const orders = await Order.find({
      $or: [
        { "shopOrders.deliveredBy": deliveryBoyId },
        { "shopOrders.assignedDeliveryBoy": deliveryBoyId, "shopOrders.status": "delivered" }
      ]
    }).lean();

    let monthDelivered = [];
    let peakHourDeliveries = 0;

    orders.forEach(order => {
      order.shopOrders.forEach(shopOrder => {
        const isDeliveredByMe = 
          (shopOrder.deliveredBy && String(shopOrder.deliveredBy) === String(deliveryBoyId)) ||
          (String(shopOrder.assignedDeliveryBoy) === String(deliveryBoyId) && shopOrder.status === "delivered");
        
        if (
          isDeliveredByMe &&
          shopOrder.status === "delivered" &&
          shopOrder.deliveredAt &&
          new Date(shopOrder.deliveredAt) >= startOfMonth
        ) {
          monthDelivered.push(shopOrder);
          const hour = new Date(shopOrder.deliveredAt).getHours();
          if (PEAK_HOURS.includes(hour)) {
            peakHourDeliveries++;
          }
        }
      });
    });

    const deliveries = monthDelivered.length;
    const payment = calculatePaymentWithBonuses(deliveries, 'monthly');
    
    // Add peak hour bonus
    const peakHourBonus = peakHourDeliveries * PEAK_HOUR_BONUS;
    payment.bonus += peakHourBonus;
    payment.total = payment.basePayment + payment.bonus;
    payment.peakHourDeliveries = peakHourDeliveries;
    payment.peakHourBonus = peakHourBonus;

    console.log('Monthly payment response:', { deliveries, ...payment });

    res.json({ 
      success: true, 
      deliveries,
      basePayment: payment.basePayment,
      bonus: payment.bonus,
      total: payment.total,
      peakHourDeliveries: payment.peakHourDeliveries,
      peakHourBonus: payment.peakHourBonus
    });
  } catch (err) {
    console.error("Monthly Payment Error:", err);
    res.status(500).json({ success: false, message: "Failed to fetch monthly payment" });
  }
};
