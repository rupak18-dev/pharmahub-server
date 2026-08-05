import { ApiError } from "../core/ApiError.js";

export const validate = (schema) => (req, _res, next) => {
  try {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
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
