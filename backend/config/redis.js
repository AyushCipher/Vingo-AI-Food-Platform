import Redis from "ioredis";
import logger from "./logger.js";

let redisClient = null;
let isRedisAvailable = false;

const REDIS_URL = process.env.REDIS_URL;

if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) {
          logger.warn("⚠️ Redis retry limit exceeded. Continuing with fallback.");
          return null; // Stop retrying
        }
        return Math.min(times * 200, 2000);
      },
      lazyConnect: false,
    });

    redisClient.on("connect", () => {
      isRedisAvailable = true;
      logger.info("✅ Redis connected successfully");
    });

    redisClient.on("error", (err) => {
      isRedisAvailable = false;
      logger.warn(`⚠️ Redis connection error: ${err.message}. Running without distributed cache.`);
    });
  } catch (error) {
    logger.warn(`⚠️ Redis initialization failed: ${error.message}`);
    redisClient = null;
    isRedisAvailable = false;
  }
} else {
  logger.info("ℹ️ REDIS_URL not configured. Running with in-memory caching fallback.");
}

// In-memory fallback cache for environments without Redis
const inMemoryCache = new Map();
const inMemoryExpiry = new Map();

export const getCache = async (key) => {
  if (isRedisAvailable && redisClient) {
    try {
      const data = await redisClient.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn(`Redis get error for ${key}: ${err.message}`);
    }
  }

  // Fallback to in-memory cache
  if (inMemoryCache.has(key)) {
    const expiry = inMemoryExpiry.get(key);
    if (expiry && Date.now() > expiry) {
      inMemoryCache.delete(key);
      inMemoryExpiry.delete(key);
      return null;
    }
    return inMemoryCache.get(key);
  }
  return null;
};

export const setCache = async (key, value, ttlSeconds = 300) => {
  if (isRedisAvailable && redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), "EX", ttlSeconds);
      return;
    } catch (err) {
      logger.warn(`Redis set error for ${key}: ${err.message}`);
    }
  }

  // Fallback to in-memory cache
  inMemoryCache.set(key, value);
  inMemoryExpiry.set(key, Date.now() + ttlSeconds * 1000);
};

export const deleteCache = async (key) => {
  if (isRedisAvailable && redisClient) {
    try {
      await redisClient.del(key);
      return;
    } catch (err) {
      logger.warn(`Redis del error for ${key}: ${err.message}`);
    }
  }
  inMemoryCache.delete(key);
  inMemoryExpiry.delete(key);
};

export const invalidatePattern = async (pattern) => {
  if (isRedisAvailable && redisClient) {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(...keys);
        logger.info(`🧹 Invalidated ${keys.length} Redis cache keys matching "${pattern}"`);
      }
      return;
    } catch (err) {
      logger.warn(`Redis invalidatePattern error for ${pattern}: ${err.message}`);
    }
  }

  // Fallback pattern matching for in-memory
  const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
  for (const key of Array.from(inMemoryCache.keys())) {
    if (regex.test(key)) {
      inMemoryCache.delete(key);
      inMemoryExpiry.delete(key);
    }
  }
};

export const createRedisPubSubClients = () => {
  if (!REDIS_URL) return null;
  try {
    const pubClient = new Redis(REDIS_URL, { lazyConnect: false });
    const subClient = pubClient.duplicate();
    return { pubClient, subClient };
  } catch (err) {
    logger.warn(`Failed to create Redis PubSub clients: ${err.message}`);
    return null;
  }
};

export const getRedisClient = () => redisClient;
export const isCacheAvailable = () => isRedisAvailable || inMemoryCache.size > 0;
