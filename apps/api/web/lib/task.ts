import { Effect } from "effect";

import type { ActionResult } from "#web/utils/api.js";
import { ServiceFailure, asServiceFailure } from "../errors.js";

export function fromPromise<A>(
  run: () => Promise<A>,
  message = "Request failed"
): Effect.Effect<A, ServiceFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => asServiceFailure(cause, message),
  });
}

export function fromSync<A>(
  run: () => A,
  message = "Request failed"
): Effect.Effect<A, ServiceFailure> {
  return Effect.try({
    try: run,
    catch: (cause) => asServiceFailure(cause, message),
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

export function toActionResult<A>(
  effect: Effect.Effect<A, ServiceFailure>
): Effect.Effect<ActionResult<A>> {
  return effect.pipe(
    Effect.map((data) => ({ success: true, data }) as const),
    Effect.catchTag("ServiceFailure", (failure) =>
      Effect.succeed({ success: false, error: failure.message } as const)
    )
  );
}

export function toVoidActionResult(
  effect: Effect.Effect<unknown, ServiceFailure>
): Effect.Effect<ActionResult> {
  return effect.pipe(
    Effect.map(() => ({ success: true, data: undefined }) as const),
    Effect.catchTag("ServiceFailure", (failure) =>
      Effect.succeed({ success: false, error: failure.message } as const)
    )
  );
}
