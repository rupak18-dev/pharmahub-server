import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { asyncHandler } from "../core/asyncHandler.js";
import { User } from "../models/User.js";

export const auth = asyncHandler(async (req, _res, next) => {
  const token = req.cookies?.[env.cookie.name] ?? bearerToken(req);
  if (!token) {
    throw ApiError.unauthorized("Missing or malformed Authorization header");
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
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

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7).trim();
}
