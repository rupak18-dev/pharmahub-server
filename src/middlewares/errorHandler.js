import { ApiError } from "../core/ApiError.js";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";

export function notFound(_req, _res, next) {
  next(ApiError.notFound("Route not found"));
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        message: err.message,
        details: err.details,
      },
    });
  }

  if (err?.name === "ValidationError" && err.errors) {
    const details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(422).json({
      success: false,
      error: { message: "Validation error", details },
    });
  }

  if (err?.code === 11000) {
    return res.status(409).json({
      success: false,
      error: { message: "Duplicate value: record already exists" },
    });
  }

  if (err?.name === "CastError") {
    return res.status(400).json({
      success: false,
      error: { message: `Invalid value for field "${err.path}"` },
    });
  }

  logger.error(`Unhandled error: ${err?.message}`, err);

  if (!env.isProduction) {
    return res.status(500).json({
      success: false,
      error: { message: err?.message ?? "Internal server error", stack: err?.stack },
    });
  }
  return res.status(500).json({
    success: false,
    error: { message: "Internal server error" },
  });
}
