export class ApiError extends Error {
  constructor(statusCode, message, details = null, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = isOperational;
    this.name = "ApiError";
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = "Bad request", details = null) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = "Unauthorized") {
    return new ApiError(401, message);
  }

  static forbidden(message = "Forbidden") {
    return new ApiError(403, message);
  }

  static notFound(message = "Resource not found") {
    return new ApiError(404, message);
  }

  static conflict(message = "Conflict") {
    return new ApiError(409, message);
  }

  static unprocessable(message = "Unprocessable entity", details = null) {
    return new ApiError(422, message, details);
  }

  static tooMany(message = "Too many requests") {
    return new ApiError(429, message);
  }
}
