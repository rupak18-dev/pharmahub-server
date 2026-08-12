import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { asyncHandler } from "../core/asyncHandler.js";
import { User } from "../models/User.js";

// Development-only identity: lets the app run against the backend without a
// JWT while the frontend still uses the demo auth session. Production always
// requires a valid token; tests run strict so they keep asserting 401s.
const devBypassEnabled = () =>
  env.nodeEnv === "development" && !process.env.NODE_TEST_CONTEXT;

async function devFallbackUser() {
  return User.findOne({ email: "owner@pharmahub.demo" })
    .collation({ locale: "en", strength: 2 })
    .lean();
}

export const auth = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    if (devBypassEnabled()) {
      req.user = await devFallbackUser();
      if (req.user) return next();
    }
    throw ApiError.unauthorized("Missing or malformed Authorization header");
  }

  const token = header.slice(7).trim();
  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch {
    if (devBypassEnabled()) {
      req.user = await devFallbackUser();
      if (req.user) return next();
    }
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const user = await User.findById(payload.sub).lean();
  if (!user || !user.active) {
    throw ApiError.unauthorized("User not found or deactivated");
  }

  req.user = user;
  next();
});
