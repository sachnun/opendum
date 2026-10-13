import { createHmac } from "node:crypto";
import { Duration, Effect, Schedule, Schema } from "effect";

type InternalRelayInit = Omit<RequestInit, "headers" | "body"> & {
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown> | null;
};

export type InternalQuotaPayload = {
  userId: string;
  provider: string;
  accountId: string;
  forceRefresh?: boolean;
};

export class InternalRelayNotConfiguredError extends Error {
  constructor() {
    super("NUXT_PUBLIC_PROXY_URL is required for external provider validation.");
    this.name = "InternalRelayNotConfiguredError";
  }
}

export class InternalRelayError extends Schema.TaggedError<InternalRelayError>()("InternalRelayError", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  path: Schema.String,
}) {}

function getProxyBaseUrl() {
  const value = process.env.NUXT_PUBLIC_PROXY_URL?.trim().replace(/\/+$/, "");
  return value || null;
}

function internalSignature(path: string, timestamp: string, body: string): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for internal proxy calls.");
  return createHmac("sha256", secret).update(`${timestamp}\n${path}\n${body}`).digest("hex");
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function normalizeBody(body: InternalRelayInit["body"]): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return body;
}

const relayRetrySchedule = Schedule.exponential(Duration.millis(50)).pipe(
  Schedule.jittered,
  Schedule.upTo({ times: 3 })
);

export function fetchInternalEffect(
  path: "/internal/refresh" | "/internal/quota",
  payload: Record<string, unknown>,
  signal?: AbortSignal
): Effect.Effect<Response, InternalRelayNotConfiguredError | InternalRelayError> {
  return Effect.gen(function* () {
    const proxyBaseUrl = getProxyBaseUrl();
    if (!proxyBaseUrl) return yield* Effect.fail(new InternalRelayNotConfiguredError());

    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = yield* Effect.try({
      try: () => internalSignature(path, timestamp, body),
      catch: (cause) =>
        new InternalRelayError({
          message: cause instanceof Error ? cause.message : String(cause),
          path,
        }),
    });

    const attempt = Effect.tryPromise({
      try: () =>
        fetch(`${proxyBaseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Opendum-Internal-Timestamp": timestamp,
            "X-Opendum-Internal-Signature": signature,
          },
          body,
          signal,
          cache: "no-store",
        }),
      catch: (cause) =>
        new InternalRelayError({
          message: cause instanceof Error ? cause.message : String(cause),
          path,
        }),
    });

    return yield* Effect.retry(attempt, relayRetrySchedule);
  }).pipe(Effect.withSpan("internalRelay.fetch", { attributes: { path } }));
}

export async function fetchInternalProvider(url: string, init: InternalRelayInit = {}): Promise<Response> {
  const payload = {
    url,
    method: init.method,
    headers: normalizeHeaders(init.headers),
    body: normalizeBody(init.body),
  };

  return Effect.runPromise(fetchInternalEffect("/internal/refresh", payload, init.signal ?? undefined));
}

export async function fetchInternalQuota(payload: InternalQuotaPayload, signal?: AbortSignal): Promise<Response> {
  return Effect.runPromise(fetchInternalEffect("/internal/quota", payload, signal));
}
