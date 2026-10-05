import { createHash } from "node:crypto";

import { db, pinnedProvider, providerAccountModelHealth } from "@opendum/database";
import { getRedisClient } from "~~/server/lib/redis";
import { getModelFamily, getProviderAccessRule, getProviderModelSet } from "~~/server/lib/proxy/models";
import { compareModelEntries } from "#shared/model/sort";
import { asc, eq, inArray } from "drizzle-orm";
import { PROVIDER_ACCOUNT_KEYS } from "./account-providers.ts";
import { INDICATOR_WEIGHT, type ProviderAccountIndicator, type ProviderStats } from "./account-stats.ts";

const AUTO_PIN_SENTINEL = "_auto_pinned";
const UNHEALTHY_IDLE_DECAY_MS = 10 * 60 * 1000;
const MODEL_DEGRADED_THRESHOLD = 2;
const ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD = 10;
export { ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD };
const COOLDOWN_RECOVERY_RATIO = 0.30;
const ERROR_HISTORY_KEY_PREFIX = "opendum:provider-account:error-history";
const ERROR_HISTORY_ENTRY_KEY_PREFIX = "opendum:provider-account:error-history-entry";
const ACCOUNT_OVERVIEW_CURSOR_VERSION = 2;
const PROVIDER_DETAIL_CURSOR_VERSION = 2;

type RedisErrorHistoryEntry = {
  id: string;
  providerAccountId: string;
  userId: string;
  model: string | null;
  errorCode: number;
  errorMessage: string;
  createdAt: string;
  dedupeKey?: string;
};

type AccountSummarySourceRow = {
  id: string;
  provider: string;
  isActive: boolean;
  disabledUntil: Date | string | null;
  status: string;
  statusChangedAt: Date | string | null;
  consecutiveErrors: number;
  lastUsedAt: Date | string | null;
  lastErrorAt: Date | string | null;
  lastErrorCode: number | null;
  lastSuccessAt: Date | string | null;
  lastRecoveredByRotationAt: Date | string | null;
};

export type AccountModelHealthSummaryRow = {
  providerAccountId: string;
  status: string;
  statusChangedAt: Date | string | null;
  consecutiveErrors: number;
  lastErrorAt: Date | string | null;
  lastErrorCode: number | null;
  lastSuccessAt: Date | string | null;
  unhealthyCountUpdatedAt: Date | string | null;
};

export type AccountHealthAggregate = {
  unhealthyCount: number;
  warningCount: number;
  lastErrorAt: Date | string | null;
  lastSuccessAt: Date | string | null;
};

export interface AccountReadOptions {
  autoPin?: boolean;
}

export type AccountOverviewSummary = { connected: number; active: number; indicator: ProviderAccountIndicator; stats: ProviderStats };
export type AccountStatsResult = Awaited<ReturnType<typeof import("./account-stats.ts").buildAccountStats>>;

export type AccountOverviewCursor = {
  pinned: string;
  summaries: string;
};

export type ProviderDetailCursor = {
  v: typeof PROVIDER_DETAIL_CURSOR_VERSION;
  accounts: Record<string, string>;
  supportedModels: string;
  freeSupportedModels: string;
  supportedModelsByAccountId: Record<string, string>;
  disabledModelsByAccountId: Record<string, string>;
  modelHealthByAccountId: Record<string, string>;
  pinnedProviders: string;
};

export function accountIsEffectivelyActive(account: { isActive: boolean; disabledUntil: Date | string | null }, now = new Date()): boolean {
  if (!account.isActive) return false;
  if (!account.disabledUntil) return true;

  const disabledUntil = account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
  return Number.isNaN(disabledUntil.getTime()) || disabledUntil <= now;
}

export function withEffectiveActive<T extends { isActive: boolean; disabledUntil: Date | string | null }>(account: T, now = new Date()): T {
  return { ...account, isActive: accountIsEffectivelyActive(account, now) };
}

export function normalizeTierForModelAccess(tier: string | null | undefined): string | null {
  if (!tier) return null;
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (normalized === "education" || normalized === "educational" || normalized === "edu" || normalized === "free-educational-quota") return "student";
  return normalized || null;
}

export function accountTierCanAccessModel(accountTier: string | null | undefined, model: string, provider: string): boolean {
  const accessRule = getProviderAccessRule(model, provider);
  if (!accessRule?.allowedTiers?.length && !accessRule?.minTier) return true;

  const normalizedAccountTier = normalizeTierForModelAccess(accountTier);
  if (accessRule.allowedTiers?.length) {
    return accessRule.allowedTiers.some((tier) => normalizeTierForModelAccess(tier) === normalizedAccountTier);
  }

  const requiredTier = normalizeTierForModelAccess(accessRule.minTier);
  return !requiredTier || requiredTier === "free" || normalizedAccountTier === requiredTier;
}

export function providerModelIsAccessibleByAccounts(model: string, provider: string, accounts: Array<{ tier: string | null }>): boolean {
  if (accounts.length === 0) return true;
  const accessRule = getProviderAccessRule(model, provider);
  if (!accessRule?.allowedTiers?.length && !accessRule?.minTier) return true;
  return accounts.some((account) => accountTierCanAccessModel(account.tier, model, provider));
}

export function sortProviderModels(models: string[]): string[] {
  return [...models].sort((a, b) => compareModelEntries({ id: a, family: getModelFamily(a) }, { id: b, family: getModelFamily(b) }));
}

export function getProviderModelsForAccountTier(provider: string, tier: string | null | undefined): string[] {
  return sortProviderModels(Array.from(getProviderModelSet(provider)).filter((model) => accountTierCanAccessModel(tier, model, provider)));
}

export function toTimeMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

export function effectiveUnhealthyCount(row: { consecutiveErrors: number; unhealthyCountUpdatedAt?: Date | string | null; lastErrorAt?: Date | string | null; lastSuccessAt?: Date | string | null; updatedAt?: Date | string | null; createdAt?: Date | string | null }, now = new Date()): number {
  if (row.consecutiveErrors <= 0) return 0;
  const lastRequestMs = Math.max(
    toTimeMs(row.unhealthyCountUpdatedAt) ?? 0,
    toTimeMs(row.lastErrorAt) ?? 0,
    toTimeMs(row.lastSuccessAt) ?? 0,
    toTimeMs(row.updatedAt) ?? 0,
    toTimeMs(row.createdAt) ?? 0,
  );
  if (!lastRequestMs || lastRequestMs > now.getTime()) return row.consecutiveErrors;

  const decay = Math.floor((now.getTime() - lastRequestMs) / UNHEALTHY_IDLE_DECAY_MS);
  return Math.max(0, row.consecutiveErrors - decay);
}

export function modelHealthStatus(unhealthyCount: number): string {
  return unhealthyCount >= MODEL_DEGRADED_THRESHOLD ? "degraded" : "active";
}

export function cooldownRecoveryCount(unhealthyCount: number): number {
  if (unhealthyCount <= 0) return 0;
  return Math.max(0, unhealthyCount - Math.round(unhealthyCount * COOLDOWN_RECOVERY_RATIO));
}

export function isImmediatelyRecoverableStatusCode(code: number | null | undefined): boolean {
  if (!code) return false;
  return code === 408 || code === 429 || code >= 500;
}

export function hasRecoveredAfterError(row: { lastErrorAt?: Date | string | null; lastSuccessAt?: Date | string | null; lastRecoveredByRotationAt?: Date | string | null; lastUsedAt?: Date | string | null }): boolean {
  const errorMs = toTimeMs(row.lastErrorAt);
  if (!errorMs) return false;
  const recoveredMs = Math.max(toTimeMs(row.lastSuccessAt) ?? 0, toTimeMs(row.lastRecoveredByRotationAt) ?? 0, toTimeMs(row.lastUsedAt) ?? 0);
  return recoveredMs > errorMs;
}

export function hasActionableHealthWarning(row: { consecutiveErrors: number; lastErrorAt?: Date | string | null; lastErrorCode?: number | null; lastSuccessAt?: Date | string | null }): boolean {
  if (row.consecutiveErrors <= 0) return false;
  if (row.consecutiveErrors >= MODEL_DEGRADED_THRESHOLD) return true;
  return !(isImmediatelyRecoverableStatusCode(row.lastErrorCode) && hasRecoveredAfterError(row));
}

export function getRecoveredAccountIndicator(account: AccountSummarySourceRow): ProviderAccountIndicator {
  const errorMs = toTimeMs(account.lastErrorAt);
  if (!errorMs) return "normal";
  if (!hasRecoveredAfterError(account)) return "error";
  return isImmediatelyRecoverableStatusCode(account.lastErrorCode) ? "normal" : "warning";
}

export function withEffectiveModelHealth<T extends AccountModelHealthSummaryRow>(row: T, now = new Date(), applyCooldownRecovery = false): T {
  const consecutiveErrors = applyCooldownRecovery ? cooldownRecoveryCount(effectiveUnhealthyCount(row, now)) : effectiveUnhealthyCount(row, now);
  return { ...row, consecutiveErrors, status: modelHealthStatus(consecutiveErrors) };
}

export function accountHasActiveCooldown(account: { status: string; disabledUntil: Date | string | null }, now = new Date()): boolean {
  if (account.status !== "failed") return false;
  const disabledUntilMs = toTimeMs(account.disabledUntil);
  return !disabledUntilMs || disabledUntilMs > now.getTime();
}

export function getCooldownRecoveryAccountIds(accounts: Array<{ id: string; status: string; disabledUntil: Date | string | null }>, now = new Date()): Set<string> {
  return new Set(accounts.flatMap((account) => {
    if (account.status !== "failed") return [];
    const disabledUntilMs = toTimeMs(account.disabledUntil);
    return disabledUntilMs && disabledUntilMs <= now.getTime() ? [account.id] : [];
  }));
}

export function errorHistoryKey(accountId: string) {
  return `${ERROR_HISTORY_KEY_PREFIX}:${accountId}`;
}

export function errorHistoryEntryKey(entryId: string) {
  return `${ERROR_HISTORY_ENTRY_KEY_PREFIX}:${entryId}`;
}

export function parseRedisErrorHistoryEntry(value: string | null): RedisErrorHistoryEntry | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RedisErrorHistoryEntry>;
    if (!parsed.id || !parsed.providerAccountId || typeof parsed.errorCode !== "number" || typeof parsed.errorMessage !== "string" || !parsed.createdAt) return null;
    return {
      id: parsed.id,
      providerAccountId: parsed.providerAccountId,
      userId: parsed.userId ?? "",
      model: typeof parsed.model === "string" ? parsed.model : null,
      errorCode: parsed.errorCode,
      errorMessage: parsed.errorMessage,
      createdAt: parsed.createdAt,
      dedupeKey: parsed.dedupeKey,
    };
  } catch {
    return null;
  }
}

export async function readRedisErrorHistory(accountId: string, limit: number) {
  const redis = await getRedisClient();
  const key = errorHistoryKey(accountId);
  const ids = await redis.zRange(key, 0, Math.max(0, limit - 1), { REV: true });
  if (ids.length === 0) return [];

  const values = await redis.mGet(ids.map(errorHistoryEntryKey));
  const missingIds: string[] = [];
  const entries = values.flatMap((value, index) => {
    const entry = parseRedisErrorHistoryEntry(value);
    if (!entry || entry.providerAccountId !== accountId) {
      missingIds.push(ids[index] ?? "");
      return [];
    }
    return [{ id: entry.id, model: entry.model, errorCode: entry.errorCode, errorMessage: entry.errorMessage, createdAt: entry.createdAt }];
  });

  if (missingIds.length > 0) await redis.zRem(key, missingIds.filter(Boolean));
  return entries;
}

export async function readRedisErrorHistories(accountIds: string[], limit: number) {
  const redis = await getRedisClient();
  const idsByAccountId = Object.fromEntries(await Promise.all(accountIds.map(async (accountId) => [
    accountId,
    await redis.zRange(errorHistoryKey(accountId), 0, Math.max(0, limit - 1), { REV: true }),
  ] as const)));
  const entryRefs = Object.entries(idsByAccountId).flatMap(([accountId, ids]) => ids.map((id) => ({ accountId, id })));
  const entriesByAccountId: Record<string, Array<{ id: string; model: string | null; errorCode: number; errorMessage: string; createdAt: string }>> = Object.fromEntries(accountIds.map((accountId) => [accountId, []]));
  if (entryRefs.length === 0) return entriesByAccountId;

  const values = await redis.mGet(entryRefs.map(({ id }) => errorHistoryEntryKey(id)));
  const missingIdsByAccountId: Record<string, string[]> = {};

  for (const [index, value] of values.entries()) {
    const ref = entryRefs[index];
    if (!ref) continue;

    const entry = parseRedisErrorHistoryEntry(value);
    if (!entry || entry.providerAccountId !== ref.accountId) {
      missingIdsByAccountId[ref.accountId] = [...(missingIdsByAccountId[ref.accountId] ?? []), ref.id];
      continue;
    }

    entriesByAccountId[ref.accountId]?.push({ id: entry.id, model: entry.model, errorCode: entry.errorCode, errorMessage: entry.errorMessage, createdAt: entry.createdAt });
  }

  await Promise.all(Object.entries(missingIdsByAccountId).map(([accountId, missingIds]) => redis.zRem(errorHistoryKey(accountId), missingIds.filter(Boolean))));
  return entriesByAccountId;
}

export async function deleteRedisErrorHistory(accountId: string) {
  const redis = await getRedisClient();
  const key = errorHistoryKey(accountId);
  const ids = await redis.zRange(key, 0, -1);
  if (ids.length === 0) {
    await redis.del(key);
    return;
  }

  const values = await redis.mGet(ids.map(errorHistoryEntryKey));
  const keysToDelete = new Set<string>([key]);
  ids.forEach((id) => keysToDelete.add(errorHistoryEntryKey(id)));
  for (const value of values) {
    const entry = parseRedisErrorHistoryEntry(value);
    if (entry?.dedupeKey) keysToDelete.add(entry.dedupeKey);
  }
  await redis.del(Array.from(keysToDelete));
}

export async function getAccountSummaryHealthRows(accountIds: string[]): Promise<AccountModelHealthSummaryRow[]> {
  if (accountIds.length === 0) return [];

  return db
    .select({
      providerAccountId: providerAccountModelHealth.providerAccountId,
      status: providerAccountModelHealth.status,
      statusChangedAt: providerAccountModelHealth.statusChangedAt,
      consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
      lastErrorAt: providerAccountModelHealth.lastErrorAt,
      lastErrorCode: providerAccountModelHealth.lastErrorCode,
      lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
      unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
    })
    .from(providerAccountModelHealth)
    .where(inArray(providerAccountModelHealth.providerAccountId, accountIds));
}

export function buildAccountHealthByAccountId(healthRows: AccountModelHealthSummaryRow[], now = new Date(), cooldownRecoveryAccountIds = new Set<string>()) {
  return healthRows.map((row) => withEffectiveModelHealth(row, now, cooldownRecoveryAccountIds.has(row.providerAccountId))).reduce<Record<string, AccountHealthAggregate>>((acc, row) => {
    const current = acc[row.providerAccountId] ?? { unhealthyCount: 0, warningCount: 0, lastErrorAt: null, lastSuccessAt: null };
    current.unhealthyCount += row.consecutiveErrors;
    if (hasActionableHealthWarning(row)) current.warningCount += row.consecutiveErrors;
    if ((toTimeMs(row.lastErrorAt) ?? 0) > (toTimeMs(current.lastErrorAt) ?? 0)) current.lastErrorAt = row.lastErrorAt;
    if ((toTimeMs(row.lastSuccessAt) ?? 0) > (toTimeMs(current.lastSuccessAt) ?? 0)) current.lastSuccessAt = row.lastSuccessAt;
    acc[row.providerAccountId] = current;
    return acc;
  }, {});
}

export function hashAccountOverviewValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

export function encodeAccountOverviewCursor(pinnedProviders: string[], summaries: Record<string, AccountOverviewSummary>) {
  return [ACCOUNT_OVERVIEW_CURSOR_VERSION, hashAccountOverviewValue(pinnedProviders), hashAccountOverviewValue(summaries)].join(".");
}

export function decodeAccountOverviewCursor(cursor: string | undefined): AccountOverviewCursor | null {
  if (!cursor) return null;

  const [version, pinned, summaries, extra] = cursor.split(".");
  if (version !== String(ACCOUNT_OVERVIEW_CURSOR_VERSION) || !pinned || !summaries || extra) return null;

  return { pinned, summaries };
}

export function encodeProviderDetailCursor(detail: { accounts: Array<{ id: string }>; supportedModels: string[]; freeSupportedModels: string[]; supportedModelsByAccountId: Record<string, string[]>; disabledModelsByAccountId: Record<string, string[]>; modelHealthByAccountId: Record<string, unknown>; pinnedProviders: string[] }) {
  const cursor: ProviderDetailCursor = {
    v: PROVIDER_DETAIL_CURSOR_VERSION,
    accounts: Object.fromEntries(detail.accounts.map((account) => [account.id, hashAccountOverviewValue(account)])),
    supportedModels: hashAccountOverviewValue(detail.supportedModels),
    freeSupportedModels: hashAccountOverviewValue(detail.freeSupportedModels),
    supportedModelsByAccountId: Object.fromEntries(Object.entries(detail.supportedModelsByAccountId).map(([accountId, models]) => [accountId, hashAccountOverviewValue(models)])),
    disabledModelsByAccountId: Object.fromEntries(Object.entries(detail.disabledModelsByAccountId).map(([accountId, models]) => [accountId, hashAccountOverviewValue(models)])),
    modelHealthByAccountId: Object.fromEntries(Object.entries(detail.modelHealthByAccountId).map(([accountId, health]) => [accountId, hashAccountOverviewValue(health)])),
    pinnedProviders: hashAccountOverviewValue(detail.pinnedProviders),
  };

  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeProviderDetailCursor(cursor: string | undefined): ProviderDetailCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ProviderDetailCursor>;
    if (parsed.v !== PROVIDER_DETAIL_CURSOR_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") return null;
    if (typeof parsed.supportedModels !== "string" || typeof parsed.freeSupportedModels !== "string" || !parsed.supportedModelsByAccountId || typeof parsed.supportedModelsByAccountId !== "object") return null;
    if (!parsed.disabledModelsByAccountId || typeof parsed.disabledModelsByAccountId !== "object") return null;
    if (!parsed.modelHealthByAccountId || typeof parsed.modelHealthByAccountId !== "object" || typeof parsed.pinnedProviders !== "string") return null;

    return parsed as ProviderDetailCursor;
  } catch {
    return null;
  }
}

export function buildStatsDelta(stats: AccountStatsResult, cursors?: Record<string, string>) {
  const nextCursors = Object.fromEntries(Object.entries(stats).map(([id, value]) => [id, hashAccountOverviewValue(value)]));
  const changedStats = Object.fromEntries(Object.entries(stats).filter(([id, value]) => cursors?.[id] !== hashAccountOverviewValue(value)));

  return {
    delta: true,
    cursors: nextCursors,
    ...(Object.keys(changedStats).length > 0 ? { stats: changedStats } : {}),
  };
}

export function buildAccountPingSummaries(accounts: AccountSummarySourceRow[], healthByAccountId: Record<string, AccountHealthAggregate> = {}, now = new Date()) {
  const summaries = Object.fromEntries(
    PROVIDER_ACCOUNT_KEYS.map((provider) => [
      provider,
      {
        connected: 0,
        active: 0,
        indicator: "normal" as ProviderAccountIndicator,
      },
    ])
  ) as Record<string, { connected: number; active: number; indicator: ProviderAccountIndicator }>;

  for (const account of accounts) {
    const summary = (summaries[account.provider] ??= { connected: 0, active: 0, indicator: "normal" });
    summary.connected += 1;

    if (!accountIsEffectivelyActive(account, now)) continue;

    summary.active += 1;
    const health = healthByAccountId[account.id];
    const unhealthyCount = health?.unhealthyCount ?? account.consecutiveErrors;
    const warningCount = health?.warningCount ?? account.consecutiveErrors;
    const indicator = account.status === "failed" || unhealthyCount >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD
      ? "error"
      : warningCount > 0
        ? "warning"
        : getRecoveredAccountIndicator(account);
    if (INDICATOR_WEIGHT[indicator] > INDICATOR_WEIGHT[summary.indicator]) {
      summary.indicator = indicator;
    }
  }

  return summaries;
}

export async function getPinnedProviderKeys(userId: string, providersWithAccounts?: Iterable<string>, options: AccountReadOptions = {}): Promise<string[]> {
  const rows = await db.select({ providerKey: pinnedProvider.providerKey }).from(pinnedProvider).where(eq(pinnedProvider.userId, userId)).orderBy(asc(pinnedProvider.createdAt));

  if (rows.length === 0 && providersWithAccounts && options.autoPin !== false) {
    const providerSet = new Set(providersWithAccounts);
    const autoPinKeys = PROVIDER_ACCOUNT_KEYS.filter((provider) => providerSet.has(provider)).slice(0, 5);
    const rowsToInsert = [
      ...autoPinKeys.map((providerKey) => ({ userId, providerKey })),
      { userId, providerKey: AUTO_PIN_SENTINEL },
    ];

    if (rowsToInsert.length > 0) {
      await db.insert(pinnedProvider).values(rowsToInsert).onConflictDoNothing({ target: [pinnedProvider.userId, pinnedProvider.providerKey] });
    }

    return autoPinKeys;
  }

  return rows.map((row) => row.providerKey);
}

