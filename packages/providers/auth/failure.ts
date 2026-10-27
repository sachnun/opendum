import { Schema } from "effect";

const OptionalNumber = Schema.optional(Schema.Number);
const OptionalUnknown = Schema.optional(Schema.Unknown);

export class AuthFailure extends Schema.TaggedError<AuthFailure>()("AuthFailure", {
  message: Schema.String,
  status: OptionalNumber,
  cause: OptionalUnknown,
}) {}

export function badRequest(message: string): AuthFailure {
  return new AuthFailure({ message, status: 400 });
}

export function unauthorized(message = "Unauthorized"): AuthFailure {
  return new AuthFailure({ message, status: 401 });
}

export function unavailable(message: string, cause?: unknown): AuthFailure {
  return new AuthFailure({ message, status: 503, cause });
}

export function asFailure(cause: unknown, message = "Request failed"): AuthFailure {
  if (cause instanceof AuthFailure) return cause;
  if (cause === undefined || cause === null) return new AuthFailure({ message, status: 500, cause });
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);
  return new AuthFailure({ message: text || message, status: 500, cause });
}
