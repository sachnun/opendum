import { createHash } from "node:crypto";
import { db } from "../lib/db";
import { getRedisClient } from "../lib/redis";
import { pinnedProvider, providerAccount, providerAccountDisabledModel, providerAccountModelHealth } from "../lib/db/schema";
import { getModelFamily, getModelLookupKeys, getProviderAccessRule, getProviderModelSet, resolveModelAlias } from "../lib/proxy/models";
import { invalidateDisabledModelsCache } from "../lib/proxy/auth";
import { compareModelEntries } from "../../lib/model-sort";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { isKnownProvider, PROVIDER_ACCOUNT_KEYS, type ProviderAccountKey } from "./account-providers";
import { buildAccountStats, buildEmptyProviderStats, getProviderSummaryStats, INDICATOR_WEIGHT, type ProviderAccountIndicator, type ProviderStats } from "./account-stats";

export { createAccount, createAccountInputSchema } from "./account-connectors";

const AUTO_PIN_SENTINEL = "_auto_pinned";
const UNHEALTHY_IDLE_DECAY_MS = 10 * 60 * 1000;
const ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000;
const MODEL_DEGRADED_THRESHOLD = 2;
const ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD = 10;
const COOLDOWN_RECOVERY_RATIO = 0.30;
const DEFAULT_ERROR_HISTORY_ROWS = 100;
const MAX_ERROR_HISTORY_ROWS = 200;
const ERROR_HISTORY_KEY_PREFIX = "opendum:provider-account:error-history";
const ERROR_HISTORY_ENTRY_KEY_PREFIX = "opendum:provider-account:error-history-entry";
const ACCOUNT_OVERVIEW_CURSOR_VERSION = 2;
const PROVIDER_DETAIL_CURSOR_VERSION = 1;

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

type AccountModelHealthSummaryRow = {
  providerAccountId: string;
  status: string;
  statusChangedAt: Date | string | null;
  consecutiveErrors: number;
  lastErrorAt: Date | string | null;
  lastErrorCode: number | null;
  lastSuccessAt: Date | string | null;
  unhealthyCountUpdatedAt: Date | string | null;
};

type AccountModelHealthRecoveryRow = AccountModelHealthSummaryRow & {
  id: string;
  updatedAt: Date | string | null;
  createdAt: Date | string | null;
};

type AccountHealthAggregate = {
  unhealthyCount: number;
  warningCount: number;
  lastErrorAt: Date | string | null;
  lastSuccessAt: Date | string | null;
};

interface AccountReadOptions {
  autoPin?: boolean;
}

interface AccountOverviewReadOptions extends AccountReadOptions {
  cursor?: string;
}

type AccountOverviewSummary = { connected: number; active: number; indicator: ProviderAccountIndicator; stats: ProviderStats };
type AccountStatsResult = Awaited<ReturnType<typeof buildAccountStats>>;

type AccountOverviewCursor = {
  pinned: string;
  summaries: string;
};

type ProviderDetailCursor = {
  v: typeof PROVIDER_DETAIL_CURSOR_VERSION;
  accounts: Record<string, string>;
  supportedModels: string;
  disabledModelsByAccountId: Record<string, string>;
  modelHealthByAccountId: Record<string, string>;
  pinnedProviders: string;
};

export const providerInputSchema = z.object({
  provider: z.string().refine(isKnownProvider, "Invalid provider"),
});
export const updateAccountInputSchema = z.object({ id: z.string(), name: z.string().optional(), isActive: z.boolean().optional(), disabledUntil: z.coerce.date().nullable().optional() });
export const deleteAccountInputSchema = z.object({ id: z.string() });
export const togglePinnedProviderInputSchema = z.object({ providerKey: z.string() });
export const setAccountModelEnabledInputSchema = z.object({ accountId: z.string(), modelId: z.string(), enabled: z.boolean() });
export const errorHistoryInputSchema = z.object({ accountId: z.string(), limit: z.coerce.number().int().min(1).max(200).optional() });
export const resolveErrorsInputSchema = z.object({ accountId: z.string() });
const statsIdsQuerySchema = z.preprocess((value) => (Array.isArray(value) ? value : value == null ? [] : [value]), z.array(z.string().min(1)).max(50));
const statsCursorsQuerySchema = z.preprocess((value) => (Array.isArray(value) ? value : value == null ? [] : [value]), z.array(z.string()).max(50)).optional();

export const accountStatsInputSchema = z.object({ ids: statsIdsQuerySchema, cursors: statsCursorsQuerySchema }).transform(({ ids, cursors }) => ({
  accountIds: ids,
  cursors: cursors ? Object.fromEntries(ids.map((id, index) => [id, cursors[index] ?? ""])) : undefined,
}));
export const accountOverviewInputSchema = z.object({ cursor: z.string().min(1).optional() });
export const providerDetailInputSchema = providerInputSchema.extend({ cursor: z.string().min(1).optional() });

const providerAccountListColumns = {
  id: providerAccount.id,
  provider: providerAccount.provider,
  name: providerAccount.name,
  email: providerAccount.email,
  isActive: providerAccount.isActive,
  disabledUntil: providerAccount.disabledUntil,
  lastUsedAt: providerAccount.lastUsedAt,
  expiresAt: providerAccount.expiresAt,
  requestCount: providerAccount.requestCount,
  tier: providerAccount.tier,
  status: providerAccount.status,
  statusChangedAt: providerAccount.statusChangedAt,
  errorCount: providerAccount.errorCount,
  consecutiveErrors: providerAccount.consecutiveErrors,
  lastErrorAt: providerAccount.lastErrorAt,
  lastSuccessAt: providerAccount.lastSuccessAt,
  lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
  lastErrorCode: providerAccount.lastErrorCode,
  successCount: providerAccount.successCount,
  createdAt: providerAccount.createdAt,
};

const providerAccountLastUsedOrder = [sql`${providerAccount.lastUsedAt} desc nulls last`, desc(providerAccount.createdAt), desc(providerAccount.id)] as const;

function accountIsEffectivelyActive(account: { isActive: boolean; disabledUntil: Date | string | null }, now = new Date()): boolean {
  if (!account.isActive) return false;
  if (!account.disabledUntil) return true;

  const disabledUntil = account.disabledUntil instanceof Date ? account.disabledUntil : new Date(account.disabledUntil);
  return Number.isNaN(disabledUntil.getTime()) || disabledUntil <= now;
}

function withEffectiveActive<T extends { isActive: boolean; disabledUntil: Date | string | null }>(account: T, now = new Date()): T {
  return { ...account, isActive: accountIsEffectivelyActive(account, now) };
}

function normalizeTierForModelAccess(tier: string | null | undefined): string | null {
  if (!tier) return null;
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier" || normalized === "free-limited-copilot") return "free";
  if (normalized === "education" || normalized === "educational" || normalized === "edu" || normalized === "free-educational-quota") return "student";
  return normalized || null;
}

function accountTierCanAccessModel(accountTier: string | null | undefined, model: string, provider: string): boolean {
  const accessRule = getProviderAccessRule(model, provider);
  if (!accessRule?.allowedTiers?.length && !accessRule?.minTier) return true;

  const normalizedAccountTier = normalizeTierForModelAccess(accountTier);
  if (accessRule.allowedTiers?.length) {
    return accessRule.allowedTiers.some((tier) => normalizeTierForModelAccess(tier) === normalizedAccountTier);
  }

  const requiredTier = normalizeTierForModelAccess(accessRule.minTier);
  return !requiredTier || requiredTier === "free" || normalizedAccountTier === requiredTier;
}

function providerModelIsAccessibleByAccounts(model: string, provider: string, accounts: Array<{ tier: string | null }>): boolean {
  if (provider !== "gemini_cli") return true;
  const accessRule = getProviderAccessRule(model, provider);
  if (!accessRule?.allowedTiers?.length && !accessRule?.minTier) return true;
  return accounts.some((account) => accountTierCanAccessModel(account.tier, model, provider));
}

function toTimeMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

function effectiveUnhealthyCount(row: { consecutiveErrors: number; unhealthyCountUpdatedAt?: Date | string | null; lastErrorAt?: Date | string | null; lastSuccessAt?: Date | string | null; updatedAt?: Date | string | null; createdAt?: Date | string | null }, now = new Date()): number {
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

function modelHealthStatus(unhealthyCount: number): string {
  return unhealthyCount >= MODEL_DEGRADED_THRESHOLD ? "degraded" : "active";
}

function cooldownRecoveryCount(unhealthyCount: number): number {
  if (unhealthyCount <= 0) return 0;
  return Math.max(0, unhealthyCount - Math.round(unhealthyCount * COOLDOWN_RECOVERY_RATIO));
}

function isImmediatelyRecoverableStatusCode(code: number | null | undefined): boolean {
  if (!code) return false;
  return code === 408 || code === 429 || code >= 500;
}

function hasRecoveredAfterError(row: { lastErrorAt?: Date | string | null; lastSuccessAt?: Date | string | null; lastRecoveredByRotationAt?: Date | string | null; lastUsedAt?: Date | string | null }): boolean {
  const errorMs = toTimeMs(row.lastErrorAt);
  if (!errorMs) return false;
  const recoveredMs = Math.max(toTimeMs(row.lastSuccessAt) ?? 0, toTimeMs(row.lastRecoveredByRotationAt) ?? 0, toTimeMs(row.lastUsedAt) ?? 0);
  return recoveredMs > errorMs;
}

function hasActionableHealthWarning(row: { consecutiveErrors: number; lastErrorAt?: Date | string | null; lastErrorCode?: number | null; lastSuccessAt?: Date | string | null }): boolean {
  if (row.consecutiveErrors <= 0) return false;
  if (row.consecutiveErrors >= MODEL_DEGRADED_THRESHOLD) return true;
  return !(isImmediatelyRecoverableStatusCode(row.lastErrorCode) && hasRecoveredAfterError(row));
}

function getRecoveredAccountIndicator(account: AccountSummarySourceRow): ProviderAccountIndicator {
  const errorMs = toTimeMs(account.lastErrorAt);
  if (!errorMs) return "normal";
  if (!hasRecoveredAfterError(account)) return "error";
  return isImmediatelyRecoverableStatusCode(account.lastErrorCode) ? "normal" : "warning";
}

function withEffectiveModelHealth<T extends AccountModelHealthSummaryRow>(row: T, now = new Date(), applyCooldownRecovery = false): T {
  const consecutiveErrors = applyCooldownRecovery ? cooldownRecoveryCount(effectiveUnhealthyCount(row, now)) : effectiveUnhealthyCount(row, now);
  return { ...row, consecutiveErrors, status: modelHealthStatus(consecutiveErrors) };
}

function accountHasActiveCooldown(account: { status: string; disabledUntil: Date | string | null }, now = new Date()): boolean {
  if (account.status !== "failed") return false;
  const disabledUntilMs = toTimeMs(account.disabledUntil);
  return !disabledUntilMs || disabledUntilMs > now.getTime();
}

function getCooldownRecoveryAccountIds(accounts: Array<{ id: string; status: string; disabledUntil: Date | string | null }>, now = new Date()): Set<string> {
  return new Set(accounts.flatMap((account) => {
    if (account.status !== "failed") return [];
    const disabledUntilMs = toTimeMs(account.disabledUntil);
    return disabledUntilMs && disabledUntilMs <= now.getTime() ? [account.id] : [];
  }));
}

function errorHistoryKey(accountId: string) {
  return `${ERROR_HISTORY_KEY_PREFIX}:${accountId}`;
}

function errorHistoryEntryKey(entryId: string) {
  return `${ERROR_HISTORY_ENTRY_KEY_PREFIX}:${entryId}`;
}

function parseRedisErrorHistoryEntry(value: string | null): RedisErrorHistoryEntry | null {
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

async function readRedisErrorHistory(accountId: string, limit: number) {
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

async function deleteRedisErrorHistory(accountId: string) {
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

async function getAccountSummaryHealthRows(accountIds: string[]): Promise<AccountModelHealthSummaryRow[]> {
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

function buildAccountHealthByAccountId(healthRows: AccountModelHealthSummaryRow[], now = new Date(), cooldownRecoveryAccountIds = new Set<string>()) {
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

function hashAccountOverviewValue(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

function encodeAccountOverviewCursor(pinnedProviders: ProviderAccountKey[], summaries: Record<ProviderAccountKey, AccountOverviewSummary>) {
  return [ACCOUNT_OVERVIEW_CURSOR_VERSION, hashAccountOverviewValue(pinnedProviders), hashAccountOverviewValue(summaries)].join(".");
}

function decodeAccountOverviewCursor(cursor: string | undefined): AccountOverviewCursor | null {
  if (!cursor) return null;

  const [version, pinned, summaries, extra] = cursor.split(".");
  if (version !== String(ACCOUNT_OVERVIEW_CURSOR_VERSION) || !pinned || !summaries || extra) return null;

  return { pinned, summaries };
}

function encodeProviderDetailCursor(detail: { accounts: Array<{ id: string }>; supportedModels: string[]; disabledModelsByAccountId: Record<string, string[]>; modelHealthByAccountId: Record<string, unknown>; pinnedProviders: ProviderAccountKey[] }) {
  const cursor: ProviderDetailCursor = {
    v: PROVIDER_DETAIL_CURSOR_VERSION,
    accounts: Object.fromEntries(detail.accounts.map((account) => [account.id, hashAccountOverviewValue(account)])),
    supportedModels: hashAccountOverviewValue(detail.supportedModels),
    disabledModelsByAccountId: Object.fromEntries(Object.entries(detail.disabledModelsByAccountId).map(([accountId, models]) => [accountId, hashAccountOverviewValue(models)])),
    modelHealthByAccountId: Object.fromEntries(Object.entries(detail.modelHealthByAccountId).map(([accountId, health]) => [accountId, hashAccountOverviewValue(health)])),
    pinnedProviders: hashAccountOverviewValue(detail.pinnedProviders),
  };

  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeProviderDetailCursor(cursor: string | undefined): ProviderDetailCursor | null {
  if (!cursor) return null;

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<ProviderDetailCursor>;
    if (parsed.v !== PROVIDER_DETAIL_CURSOR_VERSION || !parsed.accounts || typeof parsed.accounts !== "object") return null;
    if (typeof parsed.supportedModels !== "string" || !parsed.disabledModelsByAccountId || typeof parsed.disabledModelsByAccountId !== "object") return null;
    if (!parsed.modelHealthByAccountId || typeof parsed.modelHealthByAccountId !== "object" || typeof parsed.pinnedProviders !== "string") return null;

    return parsed as ProviderDetailCursor;
  } catch {
    return null;
  }
}

function buildStatsDelta(stats: AccountStatsResult, cursors?: Record<string, string>) {
  const nextCursors = Object.fromEntries(Object.entries(stats).map(([id, value]) => [id, hashAccountOverviewValue(value)]));
  const changedStats = Object.fromEntries(Object.entries(stats).filter(([id, value]) => cursors?.[id] !== hashAccountOverviewValue(value)));

  return {
    delta: true,
    cursors: nextCursors,
    ...(Object.keys(changedStats).length > 0 ? { stats: changedStats } : {}),
  };
}

function buildAccountPingSummaries(accounts: AccountSummarySourceRow[], healthByAccountId: Record<string, AccountHealthAggregate> = {}, now = new Date()) {
  const summaries = Object.fromEntries(
    PROVIDER_ACCOUNT_KEYS.map((provider) => [
      provider,
      {
        connected: 0,
        active: 0,
        indicator: "normal" as ProviderAccountIndicator,
      },
    ])
  ) as Record<ProviderAccountKey, { connected: number; active: number; indicator: ProviderAccountIndicator }>;

  for (const account of accounts) {
    if (!isKnownProvider(account.provider)) continue;

    const summary = summaries[account.provider];
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

async function getPinnedProviderKeys(userId: string, providersWithAccounts?: Iterable<string>, options: AccountReadOptions = {}): Promise<ProviderAccountKey[]> {
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

  return rows.map((row) => row.providerKey).filter((provider): provider is ProviderAccountKey => isKnownProvider(provider));
}

export async function listAccounts(userId: string) {
  try {
    const now = new Date();
    const accounts = await db.select(providerAccountListColumns).from(providerAccount).where(eq(providerAccount.userId, userId)).orderBy(asc(providerAccount.createdAt));
    return accounts.map((account) => ({ ...withEffectiveActive(account, now), unhealthyCount: account.consecutiveErrors }));
  } catch (error) {
    console.error("Failed to list accounts:", error);
    throw new Error("Failed to list accounts");
  }
}

export async function listAccountsByProvider(userId: string, input: z.infer<typeof providerInputSchema>) {
  try {
    const now = new Date();
    const accounts = await db.select(providerAccountListColumns).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider))).orderBy(...providerAccountLastUsedOrder);
    return accounts.map((account) => ({ ...withEffectiveActive(account, now), unhealthyCount: account.consecutiveErrors }));
  } catch (error) {
    console.error("Failed to list provider accounts:", error);
    throw new Error("Failed to list provider accounts");
  }
}

export async function getAccountOverview(userId: string, options: AccountOverviewReadOptions = {}) {
  try {
    const now = new Date();
    const [accounts, providerStats] = await Promise.all([
      db
        .select({
          id: providerAccount.id,
          provider: providerAccount.provider,
          isActive: providerAccount.isActive,
          disabledUntil: providerAccount.disabledUntil,
          status: providerAccount.status,
          statusChangedAt: providerAccount.statusChangedAt,
          consecutiveErrors: providerAccount.consecutiveErrors,
          lastUsedAt: providerAccount.lastUsedAt,
          lastErrorAt: providerAccount.lastErrorAt,
          lastErrorCode: providerAccount.lastErrorCode,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId)),
      getProviderSummaryStats(userId),
    ]);
    const [pinnedProviders, healthRows] = await Promise.all([
      getPinnedProviderKeys(userId, accounts.map((account) => account.provider), options),
      getAccountSummaryHealthRows(accounts.map((account) => account.id)),
    ]);

    const pingSummaries = buildAccountPingSummaries(accounts, buildAccountHealthByAccountId(healthRows, now, getCooldownRecoveryAccountIds(accounts, now)), now);

    const summaries = Object.fromEntries(
      PROVIDER_ACCOUNT_KEYS.map((provider) => [
        provider,
        {
          ...pingSummaries[provider],
          stats: providerStats[provider],
        },
      ])
    ) as Record<ProviderAccountKey, AccountOverviewSummary>;
    const cursor = encodeAccountOverviewCursor(pinnedProviders, summaries);
    const previousCursor = decodeAccountOverviewCursor(options.cursor);

    if (previousCursor) {
      const summariesChanged = previousCursor.summaries !== hashAccountOverviewValue(summaries);
      const pinnedChanged = previousCursor.pinned !== hashAccountOverviewValue(pinnedProviders);

      return {
        delta: true,
        cursor,
        ...(summariesChanged ? { summaries } : {}),
        ...(pinnedChanged ? { pinnedProviders } : {}),
      };
    }

    return { summaries, pinnedProviders, cursor };
  } catch (error) {
    console.error("Failed to load account summaries:", error);
    throw new Error("Failed to load account summaries");
  }
}

export async function getAccountPing(userId: string, options: AccountReadOptions = {}) {
  try {
    const now = new Date();
    const accounts = await db
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        isActive: providerAccount.isActive,
        disabledUntil: providerAccount.disabledUntil,
        status: providerAccount.status,
        statusChangedAt: providerAccount.statusChangedAt,
        consecutiveErrors: providerAccount.consecutiveErrors,
        lastUsedAt: providerAccount.lastUsedAt,
        lastErrorAt: providerAccount.lastErrorAt,
        lastErrorCode: providerAccount.lastErrorCode,
        lastSuccessAt: providerAccount.lastSuccessAt,
        lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
      })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId));
    const [pinnedProviders, healthRows] = await Promise.all([
      getPinnedProviderKeys(userId, accounts.map((account) => account.provider), options),
      getAccountSummaryHealthRows(accounts.map((account) => account.id)),
    ]);

    const pingSummaries = buildAccountPingSummaries(accounts, buildAccountHealthByAccountId(healthRows, now, getCooldownRecoveryAccountIds(accounts, now)), now);

    return {
      summaries: Object.fromEntries(pinnedProviders.map((provider) => [provider, pingSummaries[provider]])),
      pinnedProviders,
      hasConnectedAccounts: accounts.some((account) => isKnownProvider(account.provider)),
    };
  } catch (error) {
    console.error("Failed to ping account summaries:", error);
    throw new Error("Failed to ping account summaries");
  }
}

export async function getAccountsByProviderDetailed(userId: string, input: z.infer<typeof providerDetailInputSchema>) {
  try {
    const now = new Date();
    const accounts = await db
      .select(providerAccountListColumns)
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
      .orderBy(...providerAccountLastUsedOrder);

    const accountIds = accounts.map((account) => account.id);
    const supportedModels = Array.from(getProviderModelSet(input.provider))
      .filter((model) => providerModelIsAccessibleByAccounts(model, input.provider, accounts))
      .sort((a, b) => compareModelEntries({ id: a, family: getModelFamily(a) }, { id: b, family: getModelFamily(b) }));
    const healthModelKeys = Array.from(new Set(supportedModels.flatMap((model) => getModelLookupKeys(model))));
    const [disabledModelRows, healthRows, pinnedProviders] = await Promise.all([
      accountIds.length > 0
        ? db
            .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
            .from(providerAccountDisabledModel)
            .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds))
        : Promise.resolve([]),
      accountIds.length > 0 && healthModelKeys.length > 0
        ? db
            .select({
              providerAccountId: providerAccountModelHealth.providerAccountId,
              model: providerAccountModelHealth.model,
              status: providerAccountModelHealth.status,
              statusChangedAt: providerAccountModelHealth.statusChangedAt,
              consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
              lastErrorAt: providerAccountModelHealth.lastErrorAt,
              lastErrorCode: providerAccountModelHealth.lastErrorCode,
              lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
              unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
            })
            .from(providerAccountModelHealth)
            .where(and(inArray(providerAccountModelHealth.providerAccountId, accountIds), inArray(providerAccountModelHealth.model, healthModelKeys)))
        : Promise.resolve([]),
      getPinnedProviderKeys(userId),
    ]);

    const disabledModelsByAccountId = disabledModelRows.reduce<Record<string, string[]>>((acc, row) => {
      acc[row.providerAccountId] = [...(acc[row.providerAccountId] ?? []), row.model];
      return acc;
    }, {});

    const cooldownRecoveryAccountIds = getCooldownRecoveryAccountIds(accounts, now);
    const effectiveHealthRows = healthRows.map((row) => withEffectiveModelHealth(row, now, cooldownRecoveryAccountIds.has(row.providerAccountId)));
    const healthByAccountId = effectiveHealthRows.reduce<Record<string, AccountHealthAggregate>>((acc, row) => {
      const current = acc[row.providerAccountId] ?? { unhealthyCount: 0, warningCount: 0, lastErrorAt: null, lastSuccessAt: null };
      current.unhealthyCount += row.consecutiveErrors;
      if (hasActionableHealthWarning(row)) current.warningCount += row.consecutiveErrors;
      if ((toTimeMs(row.lastErrorAt) ?? 0) > (toTimeMs(current.lastErrorAt) ?? 0)) current.lastErrorAt = row.lastErrorAt;
      if ((toTimeMs(row.lastSuccessAt) ?? 0) > (toTimeMs(current.lastSuccessAt) ?? 0)) current.lastSuccessAt = row.lastSuccessAt;
      acc[row.providerAccountId] = current;
      return acc;
    }, {});
    const modelHealthByAccountId = effectiveHealthRows.reduce<Record<string, Record<string, { status: string; consecutiveErrors: number; lastErrorAt: Date | string | null; lastSuccessAt: Date | string | null }>>>((acc, row) => {
      const model = resolveModelAlias(row.model);
      const accountHealth = acc[row.providerAccountId] ?? {};
      const current = accountHealth[model];
      if (!current || row.consecutiveErrors > current.consecutiveErrors) {
        accountHealth[model] = {
          status: row.status,
          consecutiveErrors: row.consecutiveErrors,
          lastErrorAt: row.lastErrorAt,
          lastSuccessAt: row.lastSuccessAt,
        };
        acc[row.providerAccountId] = accountHealth;
      }
      return acc;
    }, {});

    const detailedAccounts = accounts.map((account) => {
      const health = healthByAccountId[account.id];
      const unhealthyCount = health?.unhealthyCount ?? account.consecutiveErrors;
      const status = accountHasActiveCooldown(account, now) || unhealthyCount >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD ? "failed" : "active";

      return {
        ...withEffectiveActive(account, now),
        status,
        consecutiveErrors: unhealthyCount,
        unhealthyCount,
        lastErrorAt: health?.lastErrorAt ?? account.lastErrorAt,
        lastSuccessAt: health?.lastSuccessAt ?? account.lastSuccessAt,
        stats: buildEmptyProviderStats(),
      };
    });

    const detail = {
      accounts: detailedAccounts,
      supportedModels,
      disabledModelsByAccountId,
      modelHealthByAccountId,
      pinnedProviders,
    };
    const cursor = encodeProviderDetailCursor(detail);
    const previousCursor = decodeProviderDetailCursor(input.cursor);

    if (previousCursor) {
      const changedAccounts = detail.accounts.filter((account) => previousCursor.accounts[account.id] !== hashAccountOverviewValue(account));
      const currentAccountIds = new Set(detail.accounts.map((account) => account.id));
      const deletedAccountIds = Object.keys(previousCursor.accounts).filter((accountId) => !currentAccountIds.has(accountId));
      const changedDisabledModels = Object.fromEntries(Object.entries(detail.disabledModelsByAccountId).filter(([accountId, models]) => previousCursor.disabledModelsByAccountId[accountId] !== hashAccountOverviewValue(models)));
      const clearedDisabledModelsByAccountId = Object.keys(previousCursor.disabledModelsByAccountId).filter((accountId) => !(accountId in detail.disabledModelsByAccountId));
      const changedModelHealth = Object.fromEntries(Object.entries(detail.modelHealthByAccountId).filter(([accountId, health]) => previousCursor.modelHealthByAccountId[accountId] !== hashAccountOverviewValue(health)));
      const clearedModelHealthByAccountId = Object.keys(previousCursor.modelHealthByAccountId).filter((accountId) => !(accountId in detail.modelHealthByAccountId));

      return {
        delta: true,
        cursor,
        ...(changedAccounts.length > 0 ? { accounts: changedAccounts } : {}),
        ...(deletedAccountIds.length > 0 ? { deletedAccountIds } : {}),
        ...(previousCursor.supportedModels !== hashAccountOverviewValue(detail.supportedModels) ? { supportedModels: detail.supportedModels } : {}),
        ...(Object.keys(changedDisabledModels).length > 0 ? { disabledModelsByAccountId: changedDisabledModels } : {}),
        ...(clearedDisabledModelsByAccountId.length > 0 ? { clearedDisabledModelsByAccountId } : {}),
        ...(Object.keys(changedModelHealth).length > 0 ? { modelHealthByAccountId: changedModelHealth } : {}),
        ...(clearedModelHealthByAccountId.length > 0 ? { clearedModelHealthByAccountId } : {}),
        ...(previousCursor.pinnedProviders !== hashAccountOverviewValue(detail.pinnedProviders) ? { pinnedProviders: detail.pinnedProviders } : {}),
      };
    }

    return { ...detail, cursor };
  } catch (error) {
    console.error("Failed to load provider account detail:", error);
    throw new Error("Failed to load provider account detail");
  }
}

export async function getAccountStats(userId: string, input: z.infer<typeof accountStatsInputSchema>) {
  try {
    const accountIds = Array.from(new Set(input.accountIds));
    if (accountIds.length === 0) return {};

    const ownedAccounts = await db
      .select({ id: providerAccount.id })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), inArray(providerAccount.id, accountIds)));
    const ownedAccountIds = ownedAccounts.map((account) => account.id);
    return buildStatsDelta(await buildAccountStats(userId, ownedAccountIds), input.cursors);
  } catch (error) {
    console.error("Failed to load account stats:", error);
    throw new Error("Failed to load account stats");
  }
}

export async function updateAccount(userId: string, input: z.infer<typeof updateAccountInputSchema>) {
    try {
      const [account] = await db.select({ id: providerAccount.id, status: providerAccount.status }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
      if (!account) return { success: false, error: "Account not found" } as const;

      const updates: { name?: string; isActive?: boolean; disabledUntil?: Date | null } = {};
      const manuallyReenabled = input.isActive === true || input.disabledUntil === null;
      const now = new Date();
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) return { success: false, error: "Please enter a name" } as const;
        updates.name = name;
      }

      if (input.disabledUntil instanceof Date) {
        if (input.disabledUntil <= now) return { success: false, error: "Please choose a future time" } as const;
        updates.isActive = true;
        updates.disabledUntil = input.disabledUntil;
      } else {
        if (input.isActive !== undefined) {
          updates.isActive = input.isActive;
          updates.disabledUntil = null;
        } else if (input.disabledUntil === null) {
          updates.disabledUntil = null;
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.update(providerAccount).set(updates).where(eq(providerAccount.id, input.id));
        if (manuallyReenabled && account.status === "failed") await accelerateAccountCooldownForManualEnable(input.id, now);
        if (updates.isActive !== undefined || updates.disabledUntil !== undefined) await invalidateDisabledModelsCache(userId);
      }

      const [updated] = await db
        .select({ id: providerAccount.id, name: providerAccount.name, isActive: providerAccount.isActive, disabledUntil: providerAccount.disabledUntil, status: providerAccount.status, statusChangedAt: providerAccount.statusChangedAt, consecutiveErrors: providerAccount.consecutiveErrors })
        .from(providerAccount)
        .where(eq(providerAccount.id, input.id))
        .limit(1);
      if (!updated) return { success: false, error: "Account not found" } as const;

      return { success: true, data: { ...withEffectiveActive(updated, now), unhealthyCount: updated.consecutiveErrors } } as const;
    } catch (error) {
      console.error("Failed to update account:", error);
      return { success: false, error: "Failed to update account" } as const;
    }
}

async function accelerateAccountCooldownForManualEnable(accountId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const rows: AccountModelHealthRecoveryRow[] = await tx
      .select({
        id: providerAccountModelHealth.id,
        providerAccountId: providerAccountModelHealth.providerAccountId,
        status: providerAccountModelHealth.status,
        statusChangedAt: providerAccountModelHealth.statusChangedAt,
        consecutiveErrors: providerAccountModelHealth.consecutiveErrors,
        lastErrorAt: providerAccountModelHealth.lastErrorAt,
        lastErrorCode: providerAccountModelHealth.lastErrorCode,
        lastSuccessAt: providerAccountModelHealth.lastSuccessAt,
        unhealthyCountUpdatedAt: providerAccountModelHealth.unhealthyCountUpdatedAt,
        updatedAt: providerAccountModelHealth.updatedAt,
        createdAt: providerAccountModelHealth.createdAt,
      })
      .from(providerAccountModelHealth)
      .where(eq(providerAccountModelHealth.providerAccountId, accountId));

    let total = 0;
    for (const row of rows) {
      const recovered = withEffectiveModelHealth(row, now, true);
      total += recovered.consecutiveErrors;
      const patch: { consecutiveErrors: number; unhealthyCountUpdatedAt: Date; status?: string; statusChangedAt?: Date } = {
        consecutiveErrors: recovered.consecutiveErrors,
        unhealthyCountUpdatedAt: now,
      };
      if (row.status === "failed" || recovered.status !== row.status) {
        patch.status = recovered.status;
        patch.statusChangedAt = now;
      }
      await tx.update(providerAccountModelHealth).set(patch).where(eq(providerAccountModelHealth.id, row.id));
    }

    const stillCoolingDown = total >= ACCOUNT_COOLDOWN_UNHEALTHY_THRESHOLD;
    await tx
      .update(providerAccount)
      .set({
        status: stillCoolingDown ? "failed" : "active",
        statusChangedAt: now,
        consecutiveErrors: total,
        disabledUntil: stillCoolingDown ? new Date(now.getTime() + ACCOUNT_COOLDOWN_MS) : null,
      })
      .where(eq(providerAccount.id, accountId));
  });
}

export async function deleteAccount(userId: string, input: z.infer<typeof deleteAccountInputSchema>) {
  try {
    const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    await db.delete(providerAccount).where(eq(providerAccount.id, input.id));
    await invalidateDisabledModelsCache(userId);
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to delete account:", error);
    return { success: false, error: "Failed to delete account" } as const;
  }
}

export async function togglePinnedProvider(userId: string, input: z.infer<typeof togglePinnedProviderInputSchema>) {
  if (!isKnownProvider(input.providerKey)) return { success: false, error: "Invalid provider" } as const;

  try {
    const [existing] = await db
      .select({ id: pinnedProvider.id })
      .from(pinnedProvider)
      .where(and(eq(pinnedProvider.userId, userId), eq(pinnedProvider.providerKey, input.providerKey)))
      .limit(1);

    if (existing) {
      await db.delete(pinnedProvider).where(eq(pinnedProvider.id, existing.id));
      return { success: true, data: { providerKey: input.providerKey, pinned: false } } as const;
    }

    await db.insert(pinnedProvider).values({ userId, providerKey: input.providerKey }).onConflictDoNothing({ target: [pinnedProvider.userId, pinnedProvider.providerKey] });
    return { success: true, data: { providerKey: input.providerKey, pinned: true } } as const;
  } catch (error) {
    console.error("Failed to toggle pinned provider:", error);
    return { success: false, error: "Failed to update pinned provider" } as const;
  }
}

export async function setAccountModelEnabled(userId: string, input: z.infer<typeof setAccountModelEnabledInputSchema>) {
  try {
    const [account] = await db
      .select({ id: providerAccount.id, provider: providerAccount.provider })
      .from(providerAccount)
      .where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId)))
      .limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const normalizedModel = resolveModelAlias(input.modelId.trim());
    if (!normalizedModel || !getProviderModelSet(account.provider).has(normalizedModel)) {
      return { success: false, error: `Model "${normalizedModel || input.modelId}" is not supported by provider "${account.provider}"` } as const;
    }

    const lookupKeys = getModelLookupKeys(normalizedModel);
    await db.delete(providerAccountDisabledModel).where(and(eq(providerAccountDisabledModel.providerAccountId, account.id), inArray(providerAccountDisabledModel.model, lookupKeys)));
    if (!input.enabled) await db.insert(providerAccountDisabledModel).values({ providerAccountId: account.id, model: normalizedModel }).onConflictDoNothing({ target: [providerAccountDisabledModel.providerAccountId, providerAccountDisabledModel.model] });

    await invalidateDisabledModelsCache(userId);
    return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
  } catch (error) {
    console.error("Failed to update account model status:", error);
    return { success: false, error: "Failed to update model status" } as const;
  }
}

export async function getAccountErrorHistory(userId: string, input: z.infer<typeof errorHistoryInputSchema>) {
  try {
    const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const entries = await readRedisErrorHistory(input.accountId, Math.min(input.limit ?? DEFAULT_ERROR_HISTORY_ROWS, MAX_ERROR_HISTORY_ROWS));

    return { success: true, data: { entries } } as const;
  } catch (error) {
    console.error("Failed to read provider account error history:", error);
    return { success: true, data: { entries: [] } } as const;
  }
}

export async function resolveAccountErrors(userId: string, input: z.infer<typeof resolveErrorsInputSchema>) {
  try {
    const [account] = await db.select({ id: providerAccount.id, status: providerAccount.status }).from(providerAccount).where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    await db
      .update(providerAccount)
      .set({
        errorCount: 0,
        consecutiveErrors: 0,
        lastErrorAt: null,
        lastErrorCode: null,
        lastRecoveredByRotationAt: null,
        ...(account.status === "failed" ? { status: "active", statusChangedAt: new Date(), disabledUntil: null } : {}),
      })
      .where(eq(providerAccount.id, input.accountId));
    await deleteRedisErrorHistory(input.accountId);
    await db.delete(providerAccountModelHealth).where(eq(providerAccountModelHealth.providerAccountId, input.accountId));
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to resolve provider account errors:", error);
    return { success: false, error: "Failed to resolve account errors" } as const;
  }
}
