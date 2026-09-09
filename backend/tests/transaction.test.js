import { describe, it, expect } from "vitest";
import { runWithTransaction } from "../utils/transaction.js";

describe("runWithTransaction Utility", () => {
  it("executes work function and returns result in non-connected/standalone state", async () => {
    const result = await runWithTransaction(async (session) => {
      // In offline/mocked environments, session is null or handled gracefully
      return { success: true, count: 5 };
    });

    expect(result).toEqual({ success: true, count: 5 });
  });

  it("propagates errors thrown inside the transaction callback", async () => {
    await expect(
      runWithTransaction(async () => {
        throw new Error("Simulated database failure");
      })
    ).rejects.toThrow("Simulated database failure");
  });
});
