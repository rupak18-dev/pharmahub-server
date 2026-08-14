import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";

const ALLOWED_ORIGINS = env.corsOrigin === "*" ? null : new Set([env.corsOrigin]);

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(req) {
  return req.headers.origin || req.headers.referer || null;
}

function isAllowed(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS === null) return true;
  return ALLOWED_ORIGINS.has(origin);
}

/**
 * CSRF guard for cookie-authenticated requests.
 *
 * Browsers always send an Origin header on cross-origin state-changing requests,
 * so when it is present it must match the configured CORS origin. Requests without
 * an Origin header (same-origin browsers, curl, native clients) are allowed.
 */
export const csrfOriginGuard = (req, _res, next) => {
  if (STATE_CHANGING_METHODS.has(req.method)) {
    const origin = originOf(req);
    if (origin && !isAllowed(origin)) {
      throw ApiError.forbidden("Cross-origin request rejected");
    }
  }
  next();
};
