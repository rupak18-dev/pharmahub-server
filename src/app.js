import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { env } from "./config/env.js";
import { constants } from "./config/constants.js";
import apiRoutes from "./routes/index.js";
import { notFound, errorHandler } from "./middlewares/errorHandler.js";
import { csrfOriginGuard } from "./middlewares/csrf.js";
import { normalizeOrigins } from "./utils/origin.js";
import { stream } from "./core/logger.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  const allowedOrigins = normalizeOrigins(env.corsOrigin);
  app.use(
    cors({
      // Dev servers (e.g. the Vite proxy) are permissive; production reflects
      // only the configured CORS origin(s).
      origin: env.isProduction && allowedOrigins.length ? allowedOrigins : true,
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  if (!env.isTest) {
    app.use(morgan(env.isProduction ? "combined" : "dev", { stream }));
  }

  app.use(
    rateLimit({
      windowMs: env.rateLimitWindowMs,
      max: env.rateLimitMax,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: { message: "Too many requests, please try again later." } },
    }),
  );

  app.get("/", (_req, res) => {
    res.status(200).json({
      success: true,
      name: constants.app.name,
      version: constants.app.version,
      docs: "/api/v1/docs",
    });
  });

  app.use(constants.app.apiPrefix, csrfOriginGuard, apiRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
