import { Data } from "effect";

/**
 * User is not authenticated or session is missing.
 */
export class UnauthorizedError extends Data.TaggedError("UnauthorizedError")<{
  readonly message: string;
}> {}

/**
 * Requested resource was not found.
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly message: string;
}> {}

/**
 * A Redis operation failed.
 * In most cases this should be caught and handled as a "fail-open" —
 * the caller proceeds without cached data rather than propagating the failure.
 */
export class RedisError extends Data.TaggedError("RedisError")<{
  readonly cause: unknown;
}> {}

/**
 * A database operation failed.
 */
export class DatabaseError extends Data.TaggedError("DatabaseError")<{
  readonly cause: unknown;
}> {}

/**
 * Input validation failed.
 */
export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly message: string;
  readonly param?: string;
  readonly code?: string;
}> {}
