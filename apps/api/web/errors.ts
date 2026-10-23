import { Schema } from "effect";

const OptionalNumber = Schema.optional(Schema.Number);
const OptionalUnknown = Schema.optional(Schema.Unknown);

export class ServiceFailure extends Schema.TaggedError<ServiceFailure>()("ServiceFailure", {
  message: Schema.String,
  status: OptionalNumber,
  cause: OptionalUnknown,
}) {}

export function badRequest(message: string): ServiceFailure {
  return new ServiceFailure({ message, status: 400 });
}

export function unauthorized(message = "Unauthorized"): ServiceFailure {
  return new ServiceFailure({ message, status: 401 });
}

export function forbidden(message = "Forbidden"): ServiceFailure {
  return new ServiceFailure({ message, status: 403 });
}

export function notFound(message: string): ServiceFailure {
  return new ServiceFailure({ message, status: 404 });
}

export function conflict(message: string): ServiceFailure {
  return new ServiceFailure({ message, status: 409 });
}

export function unavailable(message: string, cause?: unknown): ServiceFailure {
  return new ServiceFailure({ message, status: 503, cause });
}

export function internal(message: string, cause?: unknown): ServiceFailure {
  return new ServiceFailure({ message, status: 500, cause });
}

export function asServiceFailure(cause: unknown, message = "Request failed"): ServiceFailure {
  if (cause instanceof ServiceFailure) return cause;
  if (cause === undefined || cause === null) return new ServiceFailure({ message, status: 500, cause });
  const text = cause instanceof Error ? cause.message : String(cause);
  return new ServiceFailure({ message: text || message, status: 500, cause });
}
