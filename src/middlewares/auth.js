import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { asyncHandler } from "../core/asyncHandler.js";
import { User } from "../models/User.js";

export const auth = asyncHandler(async (req, _res, next) => {
  // An explicitly-presented Authorization token is the client's stated
  // identity and MUST win over the httpOnly session cookie: the cookie can be
  // stale (left over from a previous login on the same browser), and resolving
  // identity from it would serve the PREVIOUS user's data after a re-login.
  // Only fall back to the cookie when no header is sent at all.
  const bearer = bearerToken(req);
  const token = bearer ?? req.cookies?.[env.cookie.name];
  if (!token) {
    throw ApiError.unauthorized("Missing or malformed Authorization header");
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    throw ApiError.unauthorized("Invalid or expired token");
  }

  const user = await User.findById(payload.sub).lean();
  if (!user || !user.active || user.status === "removed") {
    throw ApiError.unauthorized("User account is inactive or removed");
  }

  req.user = user;
  next();
});

export const authOptional = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.[env.cookie.name] ?? bearerToken(req);
  if (!token) {
    return next();
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret, { algorithms: ["HS256"] });
    const user = await User.findById(payload.sub).lean();
    if (user && user.active && user.status !== "removed") {
      req.user = user;
    }
  } catch {
    // Optional auth silently ignores expired or invalid tokens
  }

  next();
});

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}

