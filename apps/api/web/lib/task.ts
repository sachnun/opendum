import { Effect } from "effect";

import type { ActionResult } from "@opendum/api/web/utils/api";
import { ServiceFailure, asFailure } from "@opendum/api/web/errors";

export function fromPromise<A>(
  run: () => Promise<A>,
  message = "Request failed"
): Effect.Effect<A, ServiceFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => asFailure(cause, message),
  });
}

export function fromEffect<A, E>(
  effect: Effect.Effect<A, E>,
  message = "Request failed"
): Effect.Effect<A, ServiceFailure> {
  return Effect.mapError(effect, (cause) => asFailure(cause, message));
}

export function fromSync<A>(
  run: () => A,
  message = "Request failed"
): Effect.Effect<A, ServiceFailure> {
  return Effect.try({
    try: run,
    catch: (cause) => asFailure(cause, message),
  });
}

export function withContext<A>(
  effect: Effect.Effect<A, ServiceFailure>,
  message: string
): Effect.Effect<A, ServiceFailure> {
  return Effect.mapError(effect, (failure) =>
    failure.message === message ? failure : new ServiceFailure({ ...failure, message })
  );
}

export function toResult<A>(
  effect: Effect.Effect<A, ServiceFailure>
): Effect.Effect<ActionResult<A>> {
  return effect.pipe(
    Effect.map((data) => ({ success: true, data }) as const),
    Effect.catchTag("ServiceFailure", (failure) =>
      Effect.succeed({ success: false, error: failure.message } as const)
    )
  );
}

export function toVoid(
  effect: Effect.Effect<unknown, ServiceFailure>
): Effect.Effect<ActionResult> {
  return effect.pipe(
    Effect.map(() => ({ success: true, data: undefined }) as const),
    Effect.catchTag("ServiceFailure", (failure) =>
      Effect.succeed({ success: false, error: failure.message } as const)
    )
  );
}
