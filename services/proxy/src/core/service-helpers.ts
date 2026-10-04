import { createHash } from "node:crypto";

import type { Provider, ProviderAccount } from "@opendum/providers";
import { cloneMap, numberAsInt, stringValue } from "./helpers.js";
import type { ProviderRoutingOptions, ProviderScore } from "./provider-performance.js";

export const AUTHLESS_ACCOUNT_PREFIX = "authless:";
export const UNHEALTHY_IDLE_DECAY_MS = 10 * 60 * 1000;
export const MODEL_DEGRADED_THRESHOLD = 2;
export const COOLDOWN_RECOVERY_RATIO = 0.3;

export function isSyntheticProviderAccountId(accountId: string): boolean {
  return accountId === "opencode" || accountId.startsWith(AUTHLESS_ACCOUNT_PREFIX);
}

export function normalizeAccessMode(mode: string): string {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

export function normalizeAccountIds(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))].sort((a, b) => a.localeCompare(b));
}

export function accountAccessDenial(
  accountId: string,
  access: { mode: string; accounts: string[] }
): { message: string; code: string } | null {
  const mode = normalizeAccessMode(access.mode);
  const set = new Set(normalizeAccountIds(access.accounts));
  if (mode === "whitelist" && !set.has(accountId)) {
    return { message: "Selected provider account is not allowed for this API key.", code: "provider_account_not_whitelisted" };
  }
  if (mode === "blacklist" && set.has(accountId)) {
    return { message: "Selected provider account is blocked for this API key.", code: "provider_account_blacklisted" };
  }
  return null;
}

export function refreshBufferFor(provider: Provider): number {
  const candidate = provider as unknown as { refreshBuffer?: () => number };
  if (typeof candidate.refreshBuffer === "function") {
    return candidate.refreshBuffer();
  }
  return 3 * 60 * 60 * 1000;
}

export function accountNeedsCredentialRefresh(account: ProviderAccount, provider: Provider): boolean {
  if (!account.expiresAt) return false;
  return Date.now() > account.expiresAt.getTime() - refreshBufferFor(provider);
}

export function parseRefreshErrorStatusCode(error: Error): number {
  const message = error.message;
  for (let i = 0; i + 3 <= message.length; i += 1) {
    const ch = message[i];
    if (ch < "4" || ch > "5") continue;
    if (message[i + 1] < "0" || message[i + 1] > "9" || message[i + 2] < "0" || message[i + 2] > "9") continue;
    const prevDigit = i > 0 && message[i - 1] >= "0" && message[i - 1] <= "9";
    const nextDigit = i + 3 < message.length && message[i + 3] >= "0" && message[i + 3] <= "9";
    if (prevDigit || nextDigit) continue;
    const code = Number.parseInt(message.slice(i, i + 3), 10);
    if (code >= 400 && code < 600) return code;
  }
  return 401;
}

export type HealthRow = {
  id: string;
  consecutiveErrors: number;
  status: string;
  unhealthyCountUpdatedAt: Date | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastErrorCode: number | null;
};

export function latestHealthRequestAt(row: HealthRow): Date | null {
  let latest: Date | null = row.unhealthyCountUpdatedAt;
  if (row.lastErrorAt && (!latest || row.lastErrorAt.getTime() > latest.getTime())) latest = row.lastErrorAt;
  if (row.lastSuccessAt && (!latest || row.lastSuccessAt.getTime() > latest.getTime())) latest = row.lastSuccessAt;
  if (!latest && row.updatedAt) latest = row.updatedAt;
  if (!latest && row.createdAt) latest = row.createdAt;
  return latest;
}

export function effectiveUnhealthyCount(row: HealthRow, now: Date): number {
  const count = row.consecutiveErrors;
  if (count <= 0) return 0;
  const lastRequestAt = latestHealthRequestAt(row);
  if (!lastRequestAt || lastRequestAt.getTime() > now.getTime()) return count;
  const decay = Math.trunc((now.getTime() - lastRequestAt.getTime()) / UNHEALTHY_IDLE_DECAY_MS);
  if (decay <= 0) return count;
  if (decay >= count) return 0;
  return count - decay;
}

export function modelHealthStatus(unhealthyCount: number): string {
  return unhealthyCount >= MODEL_DEGRADED_THRESHOLD ? "degraded" : "active";
}

export function cooldownRecoveryCount(unhealthyCount: number): number {
  if (unhealthyCount <= 0) return 0;
  const reduction = Math.round(unhealthyCount * COOLDOWN_RECOVERY_RATIO);
  if (reduction > unhealthyCount) return 0;
  return unhealthyCount - reduction;
}

export function isImmediatelyRecoverableStatusCode(code: number): boolean {
  return code === 408 || code === 429 || code >= 500;
}

export function successRecoveryCount(row: HealthRow, now: Date): number {
  let count = effectiveUnhealthyCount(row, now);
  if (row.lastErrorCode !== null && !isImmediatelyRecoverableStatusCode(row.lastErrorCode)) return count;
  if (count > 0) count -= 1;
  return count;
}

export function sortAccountsByProviderPriority(accounts: ProviderAccount[], priority: string[]): void {
  const order = new Map<string, number>();
  priority.forEach((provider, index) => order.set(provider, index));
  accounts.sort((a, b) => {
    const ai = order.get(a.provider) ?? 1 << 30;
    const aj = order.get(b.provider) ?? 1 << 30;
    if (ai !== aj) return ai - aj;
    if ((a.status ?? "") !== (b.status ?? "")) return (a.status ?? "") < (b.status ?? "") ? -1 : 1;
    return nullableTimeBefore(a.lastUsedAt, b.lastUsedAt) ? -1 : 0;
  });
}

export function prioritizeAccounts(
  accounts: ProviderAccount[],
  groupByProvider: boolean,
  priority: string[],
  routing?: ProviderRoutingOptions
): ProviderAccount[] {
  if (!groupByProvider) return paidFirst(accounts);
  const byProvider = new Map<string, ProviderAccount[]>();
  for (const account of accounts) {
    const list = byProvider.get(account.provider) ?? [];
    list.push(account);
    byProvider.set(account.provider, list);
  }
  const ordered = orderProvidersByPerformance([...byProvider.keys()], priority, routing);
  const result: ProviderAccount[] = [];
  for (const provider of ordered) result.push(...paidFirst(byProvider.get(provider) ?? []));
  return result;
}

export function orderProvidersByPerformance(
  present: string[],
  priority: string[],
  routing?: ProviderRoutingOptions,
  random: () => number = Math.random
): string[] {
  const known = new Set(present);
  const base = priority.filter((provider) => known.has(provider));
  for (const provider of present) {
    if (!priority.includes(provider)) base.push(provider);
  }
  if (!routing) return base;

  const scored = present
    .map((provider) => ({ provider, score: routing.scores.get(provider)?.score ?? Number.NaN }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score);
  if (scored.length === 0) return base;

  const threshold = scored[0]!.score * (1 + routing.bufferRatio);
  const pool = scored.filter((entry) => entry.score <= threshold).map((entry) => entry.provider);
  const poolSet = new Set(pool);
  const rest = base.filter((provider) => !poolSet.has(provider));

  const explore = rest.length > 0 && random() < routing.explorationRate;
  const head = explore
    ? rest[Math.min(rest.length - 1, Math.floor(random() * rest.length))]!
    : weightedPick(pool, routing.scores, random);
  if (!head) return base;

  return [
    head,
    ...pool.filter((provider) => provider !== head),
    ...rest.filter((provider) => provider !== head),
  ];
}

function weightedPick(providers: string[], scores: Map<string, ProviderScore>, random: () => number): string {
  if (providers.length === 0) return "";
  let total = 0;
  const weights = providers.map((provider) => {
    const score = scores.get(provider)?.score ?? 0;
    const weight = score > 0 ? 1 / score : 1;
    total += weight;
    return weight;
  });
  let cursor = random() * total;
  for (let index = 0; index < providers.length; index += 1) {
    cursor -= weights[index] ?? 0;
    if (cursor <= 0) return providers[index]!;
  }
  return providers[providers.length - 1]!;
}

export function paidFirst(accounts: ProviderAccount[]): ProviderAccount[] {
  const paid: ProviderAccount[] = [];
  const free: ProviderAccount[] = [];
  for (const account of accounts) {
    if (isSyntheticProviderAccountId(account.id)) free.push(account);
    else if (isPaidAccountTier(account.provider, account.tier ?? null)) paid.push(account);
    else free.push(account);
  }
  return [...paid, ...free];
}

export function isPaidAccountTier(provider: string, tier: string | null): boolean {
  if (!tier) return false;
  const value = tier.trim().toLowerCase();
  switch (provider) {
    case "antigravity":
      return value === "paid" || value === "standard-tier" || value.startsWith("g1-");
    case "kiro":
      return value === "pro" || value === "pro+" || value === "pro-plus" || value === "power";
    default:
      break;
  }
  const paid = new Set([
    "paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go",
    "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "edu",
    "education", "hc",
  ]);
  return paid.has(value);
}

export function nullableTimeBefore(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a && !b) return false;
  if (!a) return true;
  if (!b) return false;
  return a.getTime() < b.getTime();
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("upstream request timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function normalizeAccountTierAlias(tier: string): string {
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (["education", "educational", "edu", "free-educational-quota"].includes(normalized)) return "student";
  return normalized;
}

export function proxyTierSatisfiesRule(tier: string, minTier: string | undefined, allowedTiers: string[] | undefined): boolean {
  const normalized = normalizeAccountTierAlias(tier);
  if (allowedTiers && allowedTiers.length > 0) {
    return allowedTiers.some((value) => normalizeAccountTierAlias(value) === normalized);
  }
  const required = (minTier ?? "").trim().toLowerCase();
  if (!required || required === "free") return true;
  return normalized === normalizeAccountTierAlias(required);
}

export function proxyAccessRuleRestrictsTier(minTier: string | undefined, allowedTiers: string[] | undefined): boolean {
  if (allowedTiers && allowedTiers.length > 0) return true;
  const required = normalizeAccountTierAlias(minTier ?? "");
  return required !== "" && required !== "free";
}

export function quotaFallbackTierLocal(account: ProviderAccount): string {
  const tier = account.tier?.trim();
  return tier ? tier : "free";
}

export function extractSessionId(request: Request, body: Record<string, unknown>): string {
  for (const header of [
    "x-claude-code-session-id",
    "session_id",
    "x-session-id",
    "session-id",
    "x-session-affinity",
    "x-client-request-id",
  ]) {
    const value = request.headers.get(header)?.trim();
    if (value) return value;
  }
  for (const key of ["prompt_cache_key", "session_id", "sessionId", "conversation_id"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const metadata = body.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.trim()) {
      const match = /_session_([a-f0-9-]+)$/.exec(userId);
      if (match) return `claude:${match[1]}`;
      return userId.trim();
    }
  }
  const text = firstUserText(body);
  if (text && text.trim().length > 20) {
    const trimmed = text.trim().slice(0, 100);
    return `prompt:${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`;
  }
  return "";
}

export function firstUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const raw of messages) {
      const msg = (raw ?? {}) as Record<string, unknown>;
      if (msg.role !== "user") continue;
      const text = sessionTextContent(msg.content);
      if (text) return text;
    }
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const raw of input) {
      const item = (raw ?? {}) as Record<string, unknown>;
      if (item.role !== "user") continue;
      const text = sessionTextContent(item.content);
      if (text) return text;
    }
  }
  return "";
}

export function sessionTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>;
    const text = stringValue(part.text).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n");
}

