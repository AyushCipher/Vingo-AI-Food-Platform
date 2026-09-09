import { describe, it, expect } from "vitest";
import { cosineSimilarity, buildItemEmbeddingText } from "../services/embedding.service.js";

describe("Semantic Vector Search & Embedding Utilities", () => {
  it("calculates exact cosine similarity for identical vectors", () => {
    const vecA = [0.2, 0.5, 0.8, 0.1];
    const vecB = [0.2, 0.5, 0.8, 0.1];

    const similarity = cosineSimilarity(vecA, vecB);
    expect(similarity).toBeCloseTo(1.0, 5);
  });

  it("calculates orthogonal vectors similarity as 0", () => {
    const vecA = [1, 0, 0];
    const vecB = [0, 1, 0];

    const similarity = cosineSimilarity(vecA, vecB);
    expect(similarity).toBe(0);
  });

  it("calculates opposite vectors similarity as -1", () => {
    const vecA = [1, 2, 3];
    const vecB = [-1, -2, -3];

    const similarity = cosineSimilarity(vecA, vecB);
    expect(similarity).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for empty, null, or mismatched vector lengths", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity(null, [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it("constructs informative embedding prompt text from item metadata", () => {
    const item = {
      name: "Crispy Paneer Burger",
      category: "Burgers",
      type: "veg",
      description: "Crunchy spicy paneer patty with peri-peri mayo",
      price: 180,
    };

    const text = buildItemEmbeddingText(item);
    expect(text).toContain("Dish: Crispy Paneer Burger");
    expect(text).toContain("Category: Burgers");
    expect(text).toContain("Dietary: veg");
    expect(text).toContain("Description: Crunchy spicy paneer patty with peri-peri mayo");
    expect(text).toContain("Price: ₹180");
  });
});
