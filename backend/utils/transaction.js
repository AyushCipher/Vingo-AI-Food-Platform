import mongoose from "mongoose";
import logger from "../config/logger.js";

/**
 * Executes a set of database operations within an atomic MongoDB ACID transaction.
 * Automatically manages session lifecycle (start, commit, abort, end).
 * If the environment is a standalone MongoDB (which doesn't support transactions),
 * it gracefully executes the callback without a session transaction.
 *
 * @param {Function} workFn - Async callback receiving `session` as its argument: `async (session) => { ... }`
 * @returns {Promise<any>} - Returns whatever workFn resolves to.
 */
export const runWithTransaction = async (workFn) => {
  // If mongoose is not actively connected (e.g. in unit tests or offline), run without session
  if (mongoose.connection.readyState !== 1) {
    return await workFn(null);
  }

  let session = null;
  try {
    session = await mongoose.startSession();
  } catch (err) {
    logger.warn(`Could not start Mongoose session (${err.message}). Executing without transaction.`);
    return await workFn(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await workFn(session);
    });
    return result;
  } catch (error) {
    // If the error is due to MongoDB running as standalone (no replica set), fallback gracefully
    const isStandaloneError =
      error?.message?.includes("Transaction numbers are only allowed on a replica set member or mongos") ||
      error?.message?.includes("This MongoDB deployment does not support retryable writes");

    if (isStandaloneError) {
      logger.warn("Standalone MongoDB detected without replica set. Executing operation without transaction.");
      return await workFn(null);
    }

    logger.error(`Transaction aborted due to error: ${error.message}`);
    throw error;
  } finally {
    if (session) {
      await session.endSession();
    }
  }
};

export default runWithTransaction;
