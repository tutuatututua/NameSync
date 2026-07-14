/**
 * Typed application errors. Route handlers throw these; the single Fastify
 * error handler maps them to a `{ success:false, message, code }` envelope with
 * the right status. Internal (500) errors are logged server-side and never leak
 * their message to the client.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class BadRequest extends AppError {
  constructor(message = "Bad Request") {
    super(message, 400, "BAD_REQUEST");
  }
}

export class Unauthorized extends AppError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
  }
}

export class Forbidden extends AppError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
  }
}

export class NotFound extends AppError {
  constructor(message = "Not Found") {
    super(message, 404, "NOT_FOUND");
  }
}

export class Conflict extends AppError {
  constructor(message = "Conflict") {
    super(message, 409, "CONFLICT");
  }
}

/** Raised by the sign-in throttle (services/auth.service.ts). */
export class TooManyRequests extends AppError {
  constructor(message = "Too Many Requests") {
    super(message, 429, "TOO_MANY_REQUESTS");
  }
}

export class Upstream extends AppError {
  constructor(message = "Upstream service error") {
    super(message, 502, "UPSTREAM");
  }
}

export class ServiceUnavailable extends AppError {
  constructor(message = "Service Unavailable") {
    super(message, 503, "SERVICE_UNAVAILABLE");
  }
}
