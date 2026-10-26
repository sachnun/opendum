import { Effect } from "effect";
import type { QuotaAccount, QuotaContext } from "@opendum/providers/quota/types";
import { QuotaFetchFailure } from "@opendum/providers/core/errors";

const RAW_CACHE_PREFIX = "opendum:quota:raw";
const MIN_TTL = 60;
const MAX_TTL = 300;

const CACHE_HEADER_ALLOWLIST = [
  "x-codex-primary-used-percent",
  "x-codex-primary-window-minutes",
  "x-codex-primary-reset-at",
  "x-codex-secondary-used-percent",
  "x-codex-secondary-window-minutes",
  "x-codex-secondary-reset-at",
  "x-codex-credits-has-credits",
  "x-codex-credits-unlimited",
  "x-codex-credits-balance",
];

export type QuotaJsonResult = {
  statusCode: number;
  header: Headers;
  raw: string;
  cacheKey: string;
  fromCache: boolean;
};

function ttlSeconds(): number {
  const spread = MAX_TTL - MIN_TTL;
  return MIN_TTL + Math.floor(Math.random() * (spread + 1));
}

function cacheKey(account: QuotaAccount, cacheName: string, method: string, target: string, encodedBody: string): string {
  const hash = new Bun.CryptoHasher("sha256")
    .update([account.provider, account.id, cacheName, method.toUpperCase(), target, encodedBody].join("\n"))
    .digest("hex");
  return `${RAW_CACHE_PREFIX}:${account.provider}:${account.id}:${hash}`;
}

function cacheHeaders(headers: Headers): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of CACHE_HEADER_ALLOWLIST) {
    const values = headers.get(key);
    if (values) out[key] = [values];
  }
  return out;
}

function decodeEntry(raw: string, cacheKey: string): QuotaJsonResult | null {
  const entry = JSON.parse(raw) as { statusCode: number; header?: Record<string, string[]>; body: string };
  if (entry.statusCode <= 0) return null;
  const header = new Headers();
  for (const [key, values] of Object.entries(entry.header ?? {})) {
    for (const value of values) header.append(key, value);
  }
  return {
    statusCode: entry.statusCode,
    header,
    raw: Buffer.from(entry.body, "base64").toString("utf8"),
    cacheKey,
    fromCache: true,
  };
}

function fetchFailure(provider: string, target: string, cause: unknown): QuotaFetchFailure {
  return new QuotaFetchFailure({
    message: cause instanceof Error ? cause.message : String(cause),
    provider,
    target,
    cause,
  });
}

export function quotaJson(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown
): Effect.Effect<QuotaJsonResult, QuotaFetchFailure> {
  const encodedBody = body === null || body === undefined ? "" : JSON.stringify(body);
  const key = cacheKey(account, cacheName, method, target, encodedBody);

  const fromCache = Effect.gen(function* () {
    if (forceRefresh || !ctx.journal) return null;
    const raw = yield* Effect.tryPromise({
      try: () => ctx.journal!.get(key),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => null));
    if (!raw) return null;
    return yield* Effect.try(() => decodeEntry(raw, key)).pipe(
      Effect.orElseSucceed(() => null)
    );
  });

  const live = Effect.tryPromise({
    try: async () => {
      const init: RequestInit = { method };
      const requestHeaders = new Headers();
      for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
      if (Object.keys(headers).length > 0) init.headers = requestHeaders;
      if (encodedBody) init.body = encodedBody;
      const response = await ctx.fetch(target, init);
      const raw = await response.text();
      return { statusCode: response.status, header: response.headers, raw, cacheKey: key, fromCache: false };
    },
    catch: (cause) => fetchFailure(account.provider, target, cause),
  });

  return Effect.gen(function* () {
    const cached = yield* fromCache;
    if (cached) return cached;
    return yield* live;
  });
}

export function putQuota(
  ctx: QuotaContext,
  result: QuotaJsonResult
): Effect.Effect<void> {
  if (!ctx.journal || result.fromCache || result.cacheKey === "") return Effect.void;
  if (result.statusCode < 200 || result.statusCode >= 300) return Effect.void;
  const entry = {
    statusCode: result.statusCode,
    header: cacheHeaders(result.header),
    body: Buffer.from(result.raw, "utf8").toString("base64"),
  };
  return Effect.tryPromise({
    try: () => ctx.journal!.set(result.cacheKey, JSON.stringify(entry), ttlSeconds()),
    catch: (cause) => cause,
  }).pipe(Effect.ignore);
}

export function encodeQuery(base: string, values: URLSearchParams): string {
  const encoded = values.toString();
  return encoded ? `${base}?${encoded}` : base;
}
