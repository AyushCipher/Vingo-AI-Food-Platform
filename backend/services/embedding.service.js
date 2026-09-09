import Item from "../models/item.model.js";
import Shop from "../models/shop.model.js";
import logger from "../config/logger.js";

const EMBEDDING_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";

/**
 * Calculates mathematical Cosine Similarity between two numeric vectors.
 * @param {number[]} vecA
 * @param {number[]} vecB
 * @returns {number} Value between -1.0 and 1.0 (higher = more semantically similar)
 */
export const cosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
};

/**
 * Generates text for an item to embed.
 */
export const buildItemEmbeddingText = (item) => {
  const parts = [
    `Dish: ${item.name}`,
    `Category: ${item.category}`,
    `Dietary: ${item.type || "food"}`,
    item.description ? `Description: ${item.description}` : "",
    `Price: ₹${item.price}`,
  ];
  return parts.filter(Boolean).join(". ");
};

/**
 * Generates a 768-dimensional vector embedding for a given text using Gemini text-embedding-004.
 * @param {string} text
 * @returns {Promise<number[]|null>}
 */
export const generateEmbedding = async (text) => {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY || !text || !text.trim()) {
    return null;
  }

  try {
    const response = await fetch(`${EMBEDDING_API_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: {
          parts: [{ text: text.trim().slice(0, 1000) }],
        },
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      logger.warn(`Gemini Embedding API error (${response.status}): ${JSON.stringify(errorData)}`);
      return null;
    }

    const data = await response.json();
    return data?.embedding?.values || null;
  } catch (error) {
    logger.warn(`Error generating embedding: ${error.message}`);
    return null;
  }
};

/**
 * Performs Semantic Vector Search (RAG) across food items in a city.
 * Allows natural language queries such as "something spicy, crunchy, and comfort food under 250".
 *
 * @param {Object} params
 * @param {string} params.query - Natural language search query
 * @param {string} params.city - Target city
 * @param {number} [params.maxPrice] - Optional max budget
 * @param {string} [params.type] - "veg" | "non veg"
 * @param {number} [params.limit=10] - Number of top results
 * @returns {Promise<{results: Array, count: number, source: string}>}
 */
export const semanticSearchItems = async ({ query, city, maxPrice, type, limit = 10 }) => {
  if (!city) {
    return { results: [], count: 0, error: "City is required for search" };
  }

  const cityRegex = new RegExp(`^${city.trim()}$`, "i");
  const shops = await Shop.find({ city: cityRegex }).select("_id name city").lean();

  if (!shops.length) {
    return { results: [], count: 0, message: `No restaurants found in ${city}` };
  }

  const shopIds = shops.map((s) => s._id);
  const shopMap = new Map(shops.map((s) => [s._id.toString(), s.name]));

  // Build DB filter for candidate items
  const filter = { shop: { $in: shopIds }, availability: true };
  if (typeof maxPrice === "number" && !isNaN(maxPrice)) {
    filter.price = { $lte: maxPrice };
  }
  if (type === "veg" || type === "non veg") {
    filter.type = type;
  }

  // Fetch candidate items
  const candidateItems = await Item.find(filter)
    .select("+embedding name price rating type category description shop image")
    .lean();

  if (!candidateItems.length) {
    return { results: [], count: 0, message: "No items match the specified filters" };
  }

  // If no query string provided, return top items sorted by rating/price
  if (!query || !query.trim()) {
    const formatted = candidateItems.slice(0, limit).map((i) => ({
      itemId: i._id.toString(),
      name: i.name,
      shopName: shopMap.get(i.shop.toString()) || "Unknown Shop",
      shopId: i.shop.toString(),
      price: i.price,
      rating: i.rating?.average || null,
      type: i.type || null,
      category: i.category,
      description: i.description || "",
      image: i.image || "",
      similarityScore: 1.0,
    }));
    return { results: formatted, count: formatted.length, source: "filter" };
  }

  // Step 1: Generate query embedding
  const queryVector = await generateEmbedding(query);

  // If embedding API succeeded, perform vector cosine ranking
  if (queryVector) {
    // Generate missing embeddings for candidate items in parallel (batched)
    const itemsToEmbed = candidateItems.filter((it) => !it.embedding || it.embedding.length === 0);
    if (itemsToEmbed.length > 0 && itemsToEmbed.length <= 25) {
      await Promise.all(
        itemsToEmbed.map(async (item) => {
          const itemText = buildItemEmbeddingText(item);
          const emb = await generateEmbedding(itemText);
          if (emb) {
            item.embedding = emb;
            // Update in database asynchronously
            Item.findByIdAndUpdate(item._id, { embedding: emb, vectorIndexedAt: new Date() }).catch(
              () => {}
            );
          }
        })
      );
    }

    // Score and rank each item
    const scoredItems = candidateItems
      .map((item) => {
        const score = item.embedding ? cosineSimilarity(queryVector, item.embedding) : 0;
        return { item, score };
      })
      .filter((entry) => entry.score > 0.4) // Filter out semantically irrelevant dishes
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scoredItems.length > 0) {
      const results = scoredItems.map(({ item, score }) => ({
        itemId: item._id.toString(),
        name: item.name,
        shopName: shopMap.get(item.shop.toString()) || "Unknown Shop",
        shopId: item.shop.toString(),
        price: item.price,
        rating: item.rating?.average || null,
        type: item.type || null,
        category: item.category,
        description: item.description || "",
        image: item.image || "",
        similarityScore: Math.round(score * 100) / 100,
      }));
      return { results, count: results.length, source: "vector-semantic" };
    }
  }

  // Fallback: Lexical / Regex search if embeddings failed or yielded no matches
  const searchTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const regexMatches = candidateItems
    .map((item) => {
      let matchCount = 0;
      const combined = `${item.name} ${item.category} ${item.description || ""}`.toLowerCase();
      searchTerms.forEach((term) => {
        if (combined.includes(term)) matchCount++;
      });
      return { item, matchCount };
    })
    .filter((entry) => entry.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, limit);

  const fallbackResults = (regexMatches.length > 0 ? regexMatches.map((e) => e.item) : candidateItems.slice(0, limit)).map((item) => ({
    itemId: item._id.toString(),
    name: item.name,
    shopName: shopMap.get(item.shop.toString()) || "Unknown Shop",
    shopId: item.shop.toString(),
    price: item.price,
    rating: item.rating?.average || null,
    type: item.type || null,
    category: item.category,
    description: item.description || "",
    image: item.image || "",
    similarityScore: null,
  }));

  return { results: fallbackResults, count: fallbackResults.length, source: "lexical-fallback" };
};
