import { createHash } from "node:crypto";
import type Redis from "ioredis";
import type { ProviderAccount } from "../../db/index.js";
import { getJSON } from "../../providers/http.js";
import type { HttpClient, RequestContext } from "../../providers/types.js";

const internalQuotaMaxBodyBytes = 64 << 10;
const quotaRawCachePrefix = "opendum:quota:raw";
const quotaRawCacheMinTTL = 60 * 1000;
const quotaRawCacheMaxTTL = 5 * 60 * 1000;

export interface QuotaRequest {
  userId: string;
  provider: string;
  accountId: string;
  forceRefresh?: boolean;
}

export interface QuotaJSONResult {
  status: number;
  headers: Record<string, string>;
  raw: string;
  cacheKey: string;
  fromCache: boolean;
}

interface QuotaRawCacheEntry {
  statusCode: number;
  header: Record<string, string[]>;
  body: string;
  cachedAt: number;
}

export interface QuotaGroupDisplay {
  name: string;
  displayName: string;
  models: string[];
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  percentUsed: number;
  isExhausted: boolean;
  isEstimated: boolean;
  confidence: string;
  resetTimeIso: string | null;
  resetInHuman: string | null;
  remainingLabel: string | null;
}

export interface AccountQuotaInfo {
  status: string;
  error: string;
  groups: QuotaGroupDisplay[];
}

export function quotaFallbackTier(account: ProviderAccount): string {
  if (account.tier !== null && account.tier.trim() !== "") return account.tier.trim();
  return "free";
}

export function baseQuotaInfo(status: string, groups: QuotaGroupDisplay[], message: string): AccountQuotaInfo {
  return { status, error: message, groups };
}

export function expiredQuotaInfo(message: string): AccountQuotaInfo {
  return { status: "expired", error: message, groups: [] };
}

export function errorQuotaInfo(message: string): AccountQuotaInfo {
  return { status: "error", error: message, groups: [] };
}

export function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function displayNumber(value: number): number {
  if (Math.abs(value - Math.round(value)) < 0.001) return Math.round(value);
  return Math.round(value * 100) / 100;
}

export function formatTimeUntilReset(resetTimestamp: number): string | null {
  if (resetTimestamp <= 0) return null;
  const diff = resetTimestamp - Date.now();
  if (diff <= 0) return "resetting...";
  const hours = Math.floor(diff / (3600 * 1000));
  const minutes = Math.floor((diff % (3600 * 1000)) / (60 * 1000));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function formatTimeUntilResetISO(resetISO: string | null): string | null {
  if (resetISO === null || resetISO.trim() === "") return null;
  const parsed = new Date(resetISO);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatTimeUntilReset(parsed.getTime());
}

export async function getQuotaJSON(
  client: HttpClient,
  ctx: RequestContext,
  redis: Redis | null,
  account: ProviderAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<QuotaJSONResult> {
  const encodedBody = body === undefined || body === null ? null : JSON.stringify(body);
  const cacheKey = quotaRawCacheKey(account, cacheName, method, target, encodedBody);

  if (!forceRefresh && redis) {
    try {
      const raw = await redis.get(cacheKey);
      if (raw) {
        const entry = JSON.parse(raw) as QuotaRawCacheEntry;
        if (entry.statusCode > 0) {
          return { status: entry.statusCode, headers: flattenHeaders(entry.header), raw: entry.body, cacheKey, fromCache: true };
        }
      }
    } catch {
      // miss
    }
  }

  const resp = await getJSON(client, ctx, method, target, headers, body);
  const raw = await readQuotaLimit(resp.body, 1 << 20);
  return { status: resp.status, headers: resp.headers, raw, cacheKey, fromCache: false };
}

export async function putQuotaJSONCache(redis: Redis | null, result: QuotaJSONResult, headers: Record<string, string>): Promise<void> {
  if (!redis || result.fromCache || result.cacheKey === "") return;
  if (result.status < 200 || result.status >= 300) return;
  const entry: QuotaRawCacheEntry = {
    statusCode: result.status,
    header: quotaCacheHeaders(headers),
    body: result.raw,
    cachedAt: Date.now(),
  };
  try {
    await redis.set(result.cacheKey, JSON.stringify(entry), "PX", quotaRawCacheTTL());
  } catch {
    // ignore
  }
}

export function quotaRawCacheTTL(): number {
  const spread = quotaRawCacheMaxTTL - quotaRawCacheMinTTL;
  if (spread <= 0) return quotaRawCacheMinTTL;
  return quotaRawCacheMinTTL + Math.floor(Math.random() * (spread + 1));
}

export function quotaRawCacheKey(account: ProviderAccount, cacheName: string, method: string, target: string, encodedBody: string | null): string {
  const hash = createHash("sha256").update([account.provider, account.id, cacheName, method.toUpperCase(), target, encodedBody ?? ""].join("\n")).digest("hex");
  return `${quotaRawCachePrefix}:${account.provider}:${account.id}:${hash}`;
}

export function quotaCacheHeaders(headers: Record<string, string>): Record<string, string[]> {
  const allowed = [
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
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const out: Record<string, string[]> = {};
  for (const key of allowed) {
    const value = lower[key];
    if (value) out[key] = [value];
  }
  return out;
}

function flattenHeaders(header: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(header)) {
    out[k] = v.join(", ");
  }
  return out;
}

async function readQuotaLimit(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      out += decoder.decode(value, { stream: true });
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

export function parseQuotaNumber(value: unknown): [number, boolean] {
  if (typeof value === "number") {
    return [value, !Number.isNaN(value) && Number.isFinite(value)];
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isNaN(parsed) ? [0, false] : [parsed, true];
  }
  return [0, false];
}

export function parseQuotaString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseQuotaRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function parseQuotaArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function formatFloat(value: number): string {
  if (Math.abs(value - Math.round(value)) < 0.001) return value.toFixed(0);
  return value.toFixed(2);
}

export function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    if (value.trim() !== "") return value.trim();
  }
  return "";
}

export function firstNonNil(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

export function firstNumber(...values: unknown[]): [number, boolean] {
  for (const value of values) {
    const [parsed, ok] = parseQuotaNumber(value);
    if (ok) return [parsed, true];
  }
  return [0, false];
}
