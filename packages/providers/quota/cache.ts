import { createHash } from "node:crypto";
import type { QuotaAccount, QuotaContext, QuotaFetch } from "./types.js";

const RAW_CACHE_PREFIX = "opendum:quota:raw";
const RAW_CACHE_MIN_TTL_SECONDS = 60;
const RAW_CACHE_MAX_TTL_SECONDS = 300;

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

function rawCacheTtlSeconds(): number {
  const spread = RAW_CACHE_MAX_TTL_SECONDS - RAW_CACHE_MIN_TTL_SECONDS;
  return RAW_CACHE_MIN_TTL_SECONDS + Math.floor(Math.random() * (spread + 1));
}

function rawCacheKey(account: QuotaAccount, cacheName: string, method: string, target: string, encodedBody: string): string {
  const hash = createHash("sha256")
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

export async function getQuotaJson(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown
): Promise<QuotaJsonResult> {
  const encodedBody = body === null || body === undefined ? "" : JSON.stringify(body);
  const cacheKey = rawCacheKey(account, cacheName, method, target, encodedBody);

  if (!forceRefresh && ctx.journal) {
    try {
      const raw = await ctx.journal.get(cacheKey);
      if (raw) {
        const entry = JSON.parse(raw) as { statusCode: number; header?: Record<string, string[]>; body: string };
        if (entry.statusCode > 0) {
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
      }
    } catch {
      // fall through to a live request
    }
  }

  const init: RequestInit = { method };
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
  if (Object.keys(headers).length > 0) init.headers = requestHeaders;
  if (encodedBody) init.body = encodedBody;
  const response = await ctx.fetch(target, init);
  const raw = await response.text();
  return { statusCode: response.status, header: response.headers, raw, cacheKey, fromCache: false };
}

export async function putQuotaCache(ctx: QuotaContext, result: QuotaJsonResult): Promise<void> {
  if (!ctx.journal || result.fromCache || result.cacheKey === "") return;
  if (result.statusCode < 200 || result.statusCode >= 300) return;
  const entry = {
    statusCode: result.statusCode,
    header: cacheHeaders(result.header),
    body: Buffer.from(result.raw, "utf8").toString("base64"),
  };
  try {
    await ctx.journal.set(result.cacheKey, JSON.stringify(entry), rawCacheTtlSeconds());
  } catch {
    return;
  }
}

export function encodeQuery(base: string, values: URLSearchParams): string {
  const encoded = values.toString();
  return encoded ? `${base}?${encoded}` : base;
}

export function quotaFetchFor(ctx: QuotaContext): QuotaFetch {
  return ctx.fetch;
}
