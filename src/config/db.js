import mongoose from "mongoose";
import { getServers, setServers, setDefaultResultOrder } from "node:dns";

import { env } from "./env.js";
import { logger } from "../core/logger.js";

// Ensure IPv4 is preferred across all DNS lookups in Node.js.
// MongoDB Atlas replica set hostnames often return IPv6 (NAT64) addresses
// which fail or hang indefinitely on many local networks/ISPs, leading
// to getaddrinfo ENOTFOUND, 30s connection timeouts, and ReplicaSetNoPrimary drops.
try {
  setDefaultResultOrder("ipv4first");
} catch {
  // Not supported in older Node versions
}

function ensureWorkingDns() {
  try {
    setDefaultResultOrder("ipv4first");
  } catch {
    // Not supported in older Node versions
  }
  try {
    setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
  } catch {
    // Ignore if system restricts setServers
  }
}

const MONGOOSE_OPTIONS = {
  serverSelectionTimeoutMS: 20000,
  socketTimeoutMS: 45000,
  connectTimeoutMS: 20000,
  family: 4, // Strictly force IPv4 to prevent NAT64 socket drops and ECONNRESET
  maxPoolSize: 10,
  minPoolSize: 2,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
};

export async function connectDB() {
  ensureWorkingDns();
  mongoose.set("strictQuery", true);
  mongoose.connection.on("connected", () => {
    logger.info(`[db] connected to MongoDB (${mongoose.connection.name})`);
  });
  mongoose.connection.on("error", (err) => {
    logger.error(`[db] connection error: ${err.message}`);
  });
  mongoose.connection.on("disconnected", () => {
    logger.warn("[db] disconnected from MongoDB");
  });

  try {
    await mongoose.connect(env.mongoUri, MONGOOSE_OPTIONS);
  } catch (err) {
    if (
      err.message?.includes("ECONNREFUSED") ||
      err.code === "ECONNREFUSED" ||
      err.message?.includes("ENOTFOUND") ||
      err.code === "ENOTFOUND" ||
      err.name === "MongoServerSelectionError"
    ) {
      ensureWorkingDns();
      await mongoose.connect(env.mongoUri, MONGOOSE_OPTIONS);
    } else {
      throw err;
    }
  }
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
