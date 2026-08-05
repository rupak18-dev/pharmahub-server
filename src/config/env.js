import dotenv from "dotenv";

dotenv.config();

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",

  port: parseInt(process.env.PORT ?? "5000", 10),

  mongoUri: process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/pharmahub",

  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",

  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000", 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? "300", 10),
};
