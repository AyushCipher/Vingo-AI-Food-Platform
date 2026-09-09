import uploadOnCloudinary from "../config/cloudinary.js";
import Shop from "../models/shop.model.js";
import { parsePagination, applyPagination } from "../utils/pagination.js";
import { getCache, setCache, invalidatePattern } from "../config/redis.js";


export const getAllShops = async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    const cacheKey = `shops:all:p${pagination?.page || 1}:l${pagination?.limit || 20}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const shops = await applyPagination(Shop.find({}).populate("owner"), pagination);

    if (shops.length > 0) {
      await setCache(cacheKey, shops, 180);
      return res.status(200).json(shops);
    }

    return;
  } catch (error) {
    console.error("Get all shops error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


// ADD OR EDIT SHOP
export const addShop = async (req, res) => {
  try {
    const { name, city, state, address } = req.body;

    let image;
    if (req.file) {
      image = await uploadOnCloudinary(req.file.path);
    }

    // check if owner already has a shop
    let shop = await Shop.findOne({ owner: req.userId });

    // ---------------- CREATE SHOP ----------------
    if (!shop) {

      shop = await Shop.create({
        name,
        city,
        state,
        address,
        image,
        owner: req.userId
      });

    } 
    // ---------------- UPDATE SHOP ----------------
    else {

      shop.name = name;
      shop.city = city;
      shop.state = state;
      shop.address = address;

      if (image) {
        shop.image = image;
      }

      await shop.save();
    }

    await shop.populate("owner");
    await shop.populate({
      path: "items",
      options: { sort: { createdAt: -1 } },
    });

    // Invalidate shop and item query caches
    await invalidatePattern("shops:*");
    await invalidatePattern("items:*");

    return res.status(200).json(shop);

  } catch (error) {
    console.error("Add shop error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};



export const getCurrentShop = async (req, res) => {
  try {
    const shop = await Shop.findOne({ owner: req.userId })
      .populate("owner")
      .populate({
        path: "items",
        options: { sort: { createdAt: -1 } },
      });

    if (shop) {
      return res.status(200).json(shop);
    }

    return null;
  } catch (error) {
    console.error("Get current shop error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const getShopsByCity = async (req, res) => {
  try {
    const { city } = req.params;

    if (!city) {
      return res.status(400).json({ message: "City parameter is required" });
    }

    const pagination = parsePagination(req.query);
    const normalizedCity = city.toLowerCase().trim();
    const cacheKey = `shops:city:${normalizedCity}:p${pagination?.page || 1}:l${pagination?.limit || 20}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    // Case-insensitive search
    const shops = await applyPagination(
      Shop.find({
        city: { $regex: new RegExp(`^${city}$`, "i") },
      }).populate("items"),
      pagination
    );

    await setCache(cacheKey, shops, 180);
    return res.status(200).json(shops);
  } catch (error) {
    console.error("Get shop by city error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};


export const getShopById = async (req, res) => {
  try {
    const { shopId } = req.params;
    const cacheKey = `shops:id:${shopId}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    const shop = await Shop.findById(shopId);
    
    if (!shop) {
      return res.status(400).json({ message: "shop not found" });
    }
    
    await setCache(cacheKey, shop, 300);
    return res.status(200).json(shop);
  } catch (error) {
    console.error("Get shop by id error", error);
    return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
  }
};
