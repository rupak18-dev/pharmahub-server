import mongoose from "mongoose";

import { env } from "./env.js";

export async function connectDB() {
  mongoose.set("strictQuery", true);
  mongoose.connection.on("connected", () => {
    console.log(`[db] connected to MongoDB (${mongoose.connection.name})`);
  });
  mongoose.connection.on("error", (err) => {
    console.error(`[db] connection error: ${err.message}`);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("[db] disconnected from MongoDB");
  });

  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 30000,
  });
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
