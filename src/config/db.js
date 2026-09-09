import mongoose from "mongoose";
import { getServers, setServers } from "node:dns";

import { env } from "./env.js";
import { logger } from "../core/logger.js";

function ensureWorkingDns() {
  const servers = getServers();
  const stuckOnLoopback = servers.every((s) => s === "127.0.0.1" || s === "::1");
  if (stuckOnLoopback) {
    setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
  }
}

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

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 30000,
  });
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
