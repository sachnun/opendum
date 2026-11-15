import { Effect } from "effect";

export type Outcome<A> = { ok: true; value: A } | { ok: false; message: string };

function failureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(cause);
}

export function describeFailure(cause: unknown, action: string): string {
  return `Failed to ${action}: ${failureMessage(cause)}`;
}

export function runOutcome<A>(effect: Effect.Effect<A, unknown>, action: string): Promise<Outcome<A>> {
  return Effect.runPromise(
    Effect.match(effect, {
      onSuccess: (value) => ({ ok: true as const, value }),
      onFailure: (cause) => ({ ok: false as const, message: describeFailure(cause, action) }),
    })
  );
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = Effect.runSync(Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => null }));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
