import { Effect } from "effect";

/**
 * Runs a best-effort promise and discards both its value and any failure, so
 * fire-and-forget work can never fail a request.
 */
export function ignoringErrors(fn: () => Promise<unknown>): Effect.Effect<void> {
  return Effect.tryPromise({
    try: fn,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.ignore);
}

/**
 * Runs a best-effort promise and falls back to `fallback` when it fails.
 */
export function tryAsync<A>(fn: () => Promise<A>, fallback: A): Effect.Effect<A> {
  return Effect.tryPromise({
    try: fn,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.orElseSucceed(() => fallback));
}
