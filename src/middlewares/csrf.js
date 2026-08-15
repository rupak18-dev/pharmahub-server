import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { isOriginAllowed } from "../utils/origin.js";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function originOf(req) {
  if (req.headers.origin) return req.headers.origin;
  const referer = req.headers.referer;
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF guard for cookie-authenticated requests.
 *
 * Browsers always send an Origin header on cross-origin state-changing requests,
 * so when it is present it must match the configured CORS origin (trailing
 * slashes are normalized). Requests without an Origin header (same-origin
 * browsers, curl, native clients) are allowed. Enforced only in production so
 * local development through a proxy keeps working.
 */
export const csrfOriginGuard = (req, _res, next) => {
  if (env.isProduction && STATE_CHANGING_METHODS.has(req.method)) {
    const origin = originOf(req);
    if (origin && !isOriginAllowed(env.corsOrigin, origin)) {
      throw ApiError.forbidden("Cross-origin request rejected");
    }
  }
  next();
};
