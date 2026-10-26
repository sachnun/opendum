import { ORPCError } from "@orpc/server";
import { Effect } from "effect";

import type { ServiceFailure } from "@opendum/api/web/errors";

const STATUS_CODES = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  429: "TOO_MANY_REQUESTS",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
} as const;

export function orpcError(failure: ServiceFailure): ORPCError<string, unknown> {
  const status = failure.status ?? 500;
  const code = STATUS_CODES[status as keyof typeof STATUS_CODES] ?? "INTERNAL_SERVER_ERROR";
  return new ORPCError(code, {
    message: failure.message,
    cause: failure.cause,
  });
}

export function runOrpc<A>(effect: Effect.Effect<A, ServiceFailure>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.mapError(orpcError)));
}
