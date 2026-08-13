import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();
const secretEnvPath = "/etc/secrets/.env";
if (fs.existsSync(secretEnvPath)) {
  dotenv.config({ path: secretEnvPath });
}

function envVar(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

const nodeEnv = envVar("NODE_ENV", "node_env") ?? "development";
const isProduction = nodeEnv === "production";

const mongoUri = envVar("MONGO_URI", "mongo_URI", "MONGODB_URI", "MONGO_URL");

if (isProduction && !mongoUri) {
  throw new Error(
    "MONGO_URI is required in production. Add it to your Render service Environment (click 'Add from .env' to import your .env file) or upload it as a Secret File named '.env'.",
  );
}

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === "test",

  port: parseInt(envVar("PORT", "port") ?? "5000", 10),

  mongoUri: mongoUri ?? "mongodb://127.0.0.1:27017/pharmahub",

  jwtSecret: envVar("JWT_SECRET", "jwt_secret") ?? "dev-only-change-me",
  jwtExpiresIn: envVar("JWT_EXPIRES_IN", "jwt_expires_in") ?? "7d",

  corsOrigin: envVar("CORS_ORIGIN", "cors_origin") ?? "*",

  rateLimitWindowMs: parseInt(
    envVar("RATE_LIMIT_WINDOW_MS", "rate_limit_window_ms") ?? "900000",
    10,
  ),
  rateLimitMax: parseInt(envVar("RATE_LIMIT_MAX", "rate_limit_max") ?? "300", 10),
};
