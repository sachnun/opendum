import { Effect } from "effect";

export function ignore(fn: () => Promise<unknown>): Effect.Effect<void> {
  return Effect.tryPromise({
    try: fn,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.ignore);
}

export function tryAsync<A>(fn: () => Promise<A>, fallback: A): Effect.Effect<A> {
  return Effect.tryPromise({
    try: fn,
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  }).pipe(Effect.orElseSucceed(() => fallback));
}

export function raise(error: Error): never {
  return Effect.runSync(Effect.die(error));
}
