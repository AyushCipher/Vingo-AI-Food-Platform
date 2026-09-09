import { describe, it, expect, beforeEach } from "vitest";
import { getCache, setCache, deleteCache, invalidatePattern } from "../config/redis.js";

describe("Redis & In-Memory Cache Service", () => {
  beforeEach(async () => {
    await invalidatePattern("test:*");
    await invalidatePattern("shops:*");
  });

  it("sets and retrieves cached data", async () => {
    const data = [{ id: 1, name: "Pizza Palace" }];
    await setCache("test:shop:1", data, 60);

    const cached = await getCache("test:shop:1");
    expect(cached).toEqual(data);
  });

  it("returns null for non-existent cache keys", async () => {
    const cached = await getCache("test:non_existent_key");
    expect(cached).toBeNull();
  });

  it("deletes specific cached keys", async () => {
    await setCache("test:delete_me", { value: 42 }, 60);
    await deleteCache("test:delete_me");

    const cached = await getCache("test:delete_me");
    expect(cached).toBeNull();
  });

  it("invalidates keys by wildcard pattern matching", async () => {
    await setCache("shops:city:mumbai:p1", [{ id: "m1" }], 60);
    await setCache("shops:city:delhi:p1", [{ id: "d1" }], 60);
    await setCache("items:city:mumbai:p1", [{ id: "i1" }], 60);

    await invalidatePattern("shops:*");

    const mumbaiShops = await getCache("shops:city:mumbai:p1");
    const delhiShops = await getCache("shops:city:delhi:p1");
    const mumbaiItems = await getCache("items:city:mumbai:p1");

    expect(mumbaiShops).toBeNull();
    expect(delhiShops).toBeNull();
    expect(mumbaiItems).toEqual([{ id: "i1" }]);
  });
});
