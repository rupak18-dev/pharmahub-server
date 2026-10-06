import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { logger } from "../core/logger.js";

/**
 * Field names whose VALUES must never reach a log sink, at any nesting depth.
 *
 * `validate` runs against the raw request body, and it is wired onto
 * POST /auth/login, /auth/change-password and /auth/reset-password. Logging
 * `req.body` on a failed zod check therefore wrote a plaintext password or a
 * live 6-digit OTP to stdout — a typo in a phone number was enough to leak a
 * credential into the log aggregator. Keys are lowercased before lookup so
 * `newPassword` / `New-Password` style casing is still caught.
 */
const SENSITIVE_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "oldpassword",
  "confirmpassword",
  "code",
  "otp",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "secret",
  "apikey",
  "clientsecret",
  "authorization",
  "cookie",
  "setcookie",
]);

const REDACTED = "[redacted]";
const MAX_REDACT_DEPTH = 5;

/** Deep copy with every sensitive field's value replaced. Structure is preserved. */
function redact(value, depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return "[truncated]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redact(item, depth + 1);
  }
  return output;
}

/** JSON.stringify that cannot itself throw and take down the request. */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

export const validate = (schema) => (req, _res, next) => {
  try {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
      const summary =
        `[validate] 422 ${req.method} ${req.originalUrl}: ${safeStringify(details)}`;

      // The body is only ever logged outside production, and only with
      // credential fields redacted — the field names and the validation issues
      // are what a developer actually needs, and neither is sensitive.
      logger.error(
        env.isProduction
          ? summary
          : `${summary} body=${safeStringify(redact(req.body))}`,
      );
      return next(ApiError.unprocessable("Validation failed", details));
    }
    req.body = result.data;
    return next();
  } catch (err) {
    return next(err);
  }
};

export const validateParams = (schema) => (req, _res, next) => {
  try {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return next(
        ApiError.unprocessable(
          "Validation failed",
          result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
        ),
      );
    }
    req.params = result.data;
    return next();
  } catch (err) {
    return next(err);
  }
};

export const validateQuery = (schema) => (req, _res, next) => {
  try {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(ApiError.badRequest("Invalid query parameters"));
    }
    req.query = result.data;
    return next();
  } catch (err) {
    return next(err);
  }
};
