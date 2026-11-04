import { Cause, Deferred, Effect, Result } from "effect";

export type Settled<A> = { ok: true; value: A } | { ok: false; error: unknown };

export async function settle<A>(run: () => Promise<A>): Promise<Settled<A>> {
  return run().then(
    (value): Settled<A> => ({ ok: true, value }),
    (error: unknown): Settled<A> => ({ ok: false, error })
  );
}

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function raise(error: Error): never {
  return Effect.runSync(Effect.die(error));
}

export function parseJson(raw: string): unknown {
  const parsed = Result.try({ try: () => JSON.parse(raw), catch: () => null });
  return Result.isSuccess(parsed) ? parsed.success : null;
}

export function parseUrl(value: string): URL | null {
  const parsed = Result.try({ try: () => new URL(value), catch: () => null });
  return Result.isSuccess(parsed) ? parsed.success : null;
}

export function failureText(
  settled: { ok: true; value: { success: false; error: string } | { success: true } } | { ok: false; error: unknown },
  fallback: string
): string {
  if (!settled.ok) return errorText(settled.error, fallback);
  return settled.value.success ? "" : settled.value.error;
}

export function decodeHash(value: string): string {
  const decoded = Result.try({ try: () => decodeURIComponent(value), catch: () => value });
  return Result.isSuccess(decoded) ? decoded.success : value;
}

export function deferred<A>(): { promise: Promise<A>; resolve: (value: A) => void; reject: (error: unknown) => void } {
  const created = Effect.runSync(Deferred.make<A, unknown>());
  return {
    promise: Effect.runPromise(Deferred.await(created)),
    resolve: (value: A) => void Effect.runSync(Deferred.succeed(created, value)),
    reject: (error: unknown) => void Effect.runSync(Deferred.failCause(created, Cause.fail(error))),
  };
}
