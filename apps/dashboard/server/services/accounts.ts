import { db } from "../lib/db";
import { getAnalyticsCacheVersion } from "../lib/cache/analytics-cache";
import { pinnedProvider, providerAccount, providerAccountDisabledModel, providerAccountErrorHistory, providerAccountModelHealth, usageLog } from "../lib/db/schema";
import { encrypt, hashString } from "../lib/encryption";
import { getModelLookupKeys, getProviderModelMap, getProviderModelSet, resolveModelAlias } from "../lib/proxy/models";
import { invalidateDisabledModelsCache } from "../lib/proxy/auth";
import { getRedisJson, setRedisJson } from "../lib/redis-cache";
import { antigravityProvider } from "../lib/proxy/providers/antigravity";
import { REDIRECT_URI as antigravityRedirectUri, CLIENT_ID as antigravityClientId, SCOPES as antigravityScopes } from "../lib/proxy/providers/antigravity/constants";
import { API_BASE_URL as cerebrasApiBaseUrl } from "../lib/proxy/providers/cerebras/constants";
import { initiateCopilotDeviceCodeFlow, pollCopilotDeviceCodeAuthorization } from "../lib/proxy/providers/copilot";
import { codexProvider, generateCodeChallenge as generateCodexCodeChallenge, generateCodeVerifier as generateCodexCodeVerifier, CLIENT_ID as codexClientId, AUTHORIZE_ENDPOINT as codexAuthorizeEndpoint, BROWSER_REDIRECT_URI as codexBrowserRedirectUri, SCOPE as codexScope, ORIGINATOR as codexOriginator } from "../lib/proxy/providers/codex";
import { geminiCliProvider } from "../lib/proxy/providers/gemini-cli";
import { REDIRECT_URI as geminiCliRedirectUri, CLIENT_ID as geminiCliClientId, SCOPES as geminiCliScopes } from "../lib/proxy/providers/gemini-cli/constants";
import { API_BASE_URL as groqApiBaseUrl } from "../lib/proxy/providers/groq/constants";
import { buildKiroAuthUrl, generateCodeVerifier as generateKiroCodeVerifier, kiroProvider, BROWSER_REDIRECT_URI as kiroBrowserRedirectUri } from "../lib/proxy/providers/kiro";
import { API_BASE_URL as kiloCodeApiBaseUrl } from "../lib/proxy/providers/kilo-code/constants";
import { API_BASE_URL as nvidiaApiBaseUrl } from "../lib/proxy/providers/nvidia-nim/constants";
import { API_BASE_URL as ollamaApiBaseUrl } from "../lib/proxy/providers/ollama-cloud/constants";
import { API_BASE_URL as openRouterApiBaseUrl } from "../lib/proxy/providers/openrouter/constants";
import { initiateDeviceCodeFlow, pollDeviceCodeAuthorization } from "../lib/proxy/providers/qwen-code";
import type { OAuthResult } from "../lib/proxy/providers/types";
import { getWorkersAiValidationUrl } from "../lib/proxy/providers/workers-ai/constants";
import { and, asc, count as countFn, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { ActionResult } from "../utils/api";

const API_KEY_PROVIDER_ACCOUNT_EXPIRY = new Date("2100-01-01T00:00:00.000Z");
const API_KEY_VALIDATION_TIMEOUT_MS = 15000;
const PROVIDER_STATS_DAYS = 30;
const PROVIDER_DURATION_LOOKBACK_HOURS = 24;

const PROVIDER_ACCOUNT_KEYS = [
  "antigravity",
  "codex",
  "copilot",
  "gemini_cli",
  "kiro",
  "qwen_code",
  "nvidia_nim",
  "ollama_cloud",
  "openrouter",
  "groq",
  "kilo_code",
  "cerebras",
  "workers_ai",
] as const;
type ProviderAccountKey = (typeof PROVIDER_ACCOUNT_KEYS)[number];
const VALID_PROVIDER_KEYS = new Set<string>(PROVIDER_ACCOUNT_KEYS);
const WARNING_INDICATOR_STALE_WINDOW_MS = 3 * 60 * 60 * 1000;
const INDICATOR_WEIGHT = { normal: 0, warning: 1, error: 2 } as const;
const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTO_PIN_SENTINEL = "_auto_pinned";
const PROVIDER_SUMMARY_STATS_CACHE_TTL_SECONDS = 30;

const apiKeyProviderSchema = z.enum(["nvidia_nim", "ollama_cloud", "openrouter", "groq", "cerebras", "kilo_code"]);
export const providerInputSchema = z.object({ provider: z.string() });
export const createAccountInputSchema = z.object({ provider: z.string(), name: z.string().optional(), token: z.string(), cfAccountId: z.string().optional() });
export const updateAccountInputSchema = z.object({ id: z.string(), name: z.string().optional(), isActive: z.boolean().optional() });
export const deleteAccountInputSchema = z.object({ id: z.string() });
export const togglePinnedProviderInputSchema = z.object({ providerKey: z.string() });
export const setAccountModelEnabledInputSchema = z.object({ accountId: z.string(), modelId: z.string(), enabled: z.boolean() });
export const errorHistoryInputSchema = z.object({ accountId: z.string(), limit: z.number().int().min(1).max(200).optional() });
export const resolveErrorsInputSchema = z.object({ accountId: z.string() });
export const getAuthUrlInputSchema = z.object({ provider: z.enum(["antigravity", "gemini_cli", "codex", "kiro"]) });
export const exchangeOAuthInputSchema = z.object({ provider: z.enum(["antigravity", "gemini_cli", "codex", "kiro"]), callbackUrl: z.string(), state: z.string().nullable().optional(), codeVerifier: z.string().nullable().optional() });
export const initiateDeviceAuthInputSchema = z.object({ provider: z.enum(["qwen_code", "copilot"]) });
export const pollDeviceAuthInputSchema = z.object({ provider: z.enum(["qwen_code", "copilot"]), deviceCode: z.string(), codeVerifier: z.string().optional() });
type ApiKeyProvider = z.infer<typeof apiKeyProviderSchema>;

type ProviderAccountIndicator = keyof typeof INDICATOR_WEIGHT;
type ProviderStats = {
  totalRequests: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
};
type RawProviderStats = {
  totalRequests: number;
  successfulRequests: number;
  dailyCounts: Map<string, number>;
  durationByHour: Map<string, { total: number; count: number }>;
};
type OAuthProviderKey = "antigravity" | "gemini_cli" | "codex" | "kiro";

const API_KEY_PROVIDER_SETTINGS = {
  nvidia_nim: { label: "Nvidia", baseUrl: nvidiaApiBaseUrl, modelMap: getProviderModelMap("nvidia_nim"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  ollama_cloud: { label: "Ollama Cloud", baseUrl: ollamaApiBaseUrl, modelMap: getProviderModelMap("ollama_cloud"), validationPath: "/chat/completions", requireSuccessfulStatus: false },
  openrouter: { label: "OpenRouter", baseUrl: openRouterApiBaseUrl, modelMap: getProviderModelMap("openrouter"), validationPath: "/models", requireSuccessfulStatus: true },
  groq: { label: "Groq", baseUrl: groqApiBaseUrl, modelMap: getProviderModelMap("groq"), validationPath: "/models", requireSuccessfulStatus: true },
  cerebras: { label: "Cerebras", baseUrl: cerebrasApiBaseUrl, modelMap: getProviderModelMap("cerebras"), validationPath: "/models", requireSuccessfulStatus: true },
  kilo_code: { label: "Kilo Code", baseUrl: kiloCodeApiBaseUrl, modelMap: getProviderModelMap("kilo_code"), validationPath: "/models", requireSuccessfulStatus: true },
} satisfies Record<ApiKeyProvider, { label: string; baseUrl: string; modelMap: Record<string, string>; validationPath: string; requireSuccessfulStatus: boolean }>;

function isKnownProvider(provider: string): provider is ProviderAccountKey {
  return VALID_PROVIDER_KEYS.has(provider);
}

function buildDayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
}

function buildHourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function createRawStats(): RawProviderStats {
  return { totalRequests: 0, successfulRequests: 0, dailyCounts: new Map(), durationByHour: new Map() };
}

function buildEmptyProviderStats(dayKeys: string[], hourKeys: string[]): ProviderStats {
  return {
    totalRequests: 0,
    successRate: null,
    dailyRequests: dayKeys.map((date) => ({ date, count: 0 })),
    avgDurationLastDay: null,
    durationLast24Hours: hourKeys.map((time) => ({ time, avgDuration: null })),
  };
}

function generateOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

function buildGoogleOAuthUrl(provider: "antigravity" | "gemini_cli"): string {
  const config = provider === "antigravity"
    ? { clientId: antigravityClientId, redirectUri: antigravityRedirectUri, scopes: antigravityScopes }
    : { clientId: geminiCliClientId, redirectUri: geminiCliRedirectUri, scopes: geminiCliScopes };

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
  });

  return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

function parseOAuthCallbackUrl(callbackUrl: string, providerLabel: string): ActionResult<{ code: string; state: string | null }> {
  if (!callbackUrl || typeof callbackUrl !== "string") return { success: false, error: "Callback URL is required" };

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return { success: false, error: "Invalid URL format" };
  }

  const error = url.searchParams.get("error");
  if (error) {
    return { success: false, error: `${providerLabel} OAuth error: ${url.searchParams.get("error_description") || error}` };
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return { success: false, error: "No authorization code found in URL. Make sure you copied the complete URL from your browser." };
  }

  return { success: true, data: { code, state: url.searchParams.get("state") } };
}

async function upsertOAuthAccount(userId: string, provider: ProviderAccountKey, label: string, oauthResult: OAuthResult, options: { email?: string; accountId?: string | null } = {}): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const email = options.email || oauthResult.email || `${provider}-${Date.now()}`;
  const accountId = options.accountId ?? oauthResult.accountId ?? null;
  let existingAccount = null as null | { id: string; email: string | null };

  const [foundByEmail] = await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, email))).limit(1);
  existingAccount = foundByEmail ?? null;

  if (!existingAccount && accountId) {
    const [foundByAccountId] = await db.select({ id: providerAccount.id, email: providerAccount.email }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.accountId, accountId))).limit(1);
    existingAccount = foundByAccountId ?? null;
  }

  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(oauthResult.accessToken), refreshToken: encrypt(oauthResult.refreshToken), expiresAt: oauthResult.expiresAt, ...(oauthResult.projectId ? { projectId: oauthResult.projectId } : {}), ...(oauthResult.tier ? { tier: oauthResult.tier } : {}), ...(accountId ? { accountId } : {}), ...(oauthResult.email ? { email: oauthResult.email } : {}), isActive: true }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: existingAccount.email || email, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(oauthResult.accessToken), refreshToken: encrypt(oauthResult.refreshToken), expiresAt: oauthResult.expiresAt, email, projectId: oauthResult.projectId, tier: oauthResult.tier, accountId, isActive: true });
  return { success: true, data: { email, isUpdate: false } };
}

function buildStatsFromRaw(raw: RawProviderStats | undefined, dayKeys: string[], hourKeys: string[]): ProviderStats {
  if (!raw) return buildEmptyProviderStats(dayKeys, hourKeys);

  const durationLast24Hours = hourKeys.map((time) => {
    const bucket = raw.durationByHour.get(time);
    return { time, avgDuration: bucket && bucket.count > 0 ? Math.round(bucket.total / bucket.count) : null };
  });
  const durationTotalLastDay = Array.from(raw.durationByHour.values()).reduce((sum, bucket) => sum + bucket.total, 0);
  const durationCountLastDay = Array.from(raw.durationByHour.values()).reduce((sum, bucket) => sum + bucket.count, 0);

  return {
    totalRequests: raw.totalRequests,
    successRate: raw.totalRequests > 0 ? Math.round((raw.successfulRequests / raw.totalRequests) * 100) : null,
    dailyRequests: dayKeys.map((date) => ({ date, count: raw.dailyCounts.get(date) ?? 0 })),
    avgDurationLastDay: durationCountLastDay > 0 ? Math.round(durationTotalLastDay / durationCountLastDay) : null,
    durationLast24Hours,
  };
}

function getAccountIndicator(lastErrorAt: Date | string | null, lastSuccessAt: Date | string | null, lastRecoveredByRotationAt: Date | string | null): ProviderAccountIndicator {
  const errorDate = toDate(lastErrorAt);
  if (!errorDate) return "normal";

  const recoveredTimeMs = Math.max(toDate(lastSuccessAt)?.getTime() ?? 0, toDate(lastRecoveredByRotationAt)?.getTime() ?? 0);
  if (recoveredTimeMs <= errorDate.getTime()) return "error";
  if (Date.now() - errorDate.getTime() > WARNING_INDICATOR_STALE_WINDOW_MS) return "normal";
  return "warning";
}

async function getPinnedProviderKeys(userId: string, providersWithAccounts?: Iterable<string>): Promise<ProviderAccountKey[]> {
  const rows = await db.select({ providerKey: pinnedProvider.providerKey }).from(pinnedProvider).where(eq(pinnedProvider.userId, userId)).orderBy(asc(pinnedProvider.createdAt));

  if (rows.length === 0 && providersWithAccounts) {
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

async function buildProviderStats(userId: string, provider?: string): Promise<{ dayKeys: string[]; hourKeys: string[]; statsByProvider: Map<ProviderAccountKey, RawProviderStats> }> {
  const dayKeys = buildDayKeys(PROVIDER_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const durationStartDate = new Date(hourKeys[0] ?? Date.now());
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const baseConditions = [eq(usageLog.userId, userId), eq(providerAccount.userId, userId)];
  const dailyConditions = [...baseConditions, gte(usageLog.createdAt, statsStartDate)];
  const durationConditions = [...baseConditions, gte(usageLog.createdAt, durationStartDate)];
  if (provider) {
    dailyConditions.push(eq(providerAccount.provider, provider));
    durationConditions.push(eq(providerAccount.provider, provider));
  }

  const [dailyUsageRows, durationRows] = await Promise.all([
    db
      .select({ provider: providerAccount.provider, dayBucket: dayBucketExpression, requestCount: sql<number>`count(*)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` })
      .from(usageLog)
      .innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(and(...dailyConditions))
      .groupBy(providerAccount.provider, dayBucketExpression),
    db
      .select({ provider: providerAccount.provider, hourBucket: hourBucketExpression, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` })
      .from(usageLog)
      .innerJoin(providerAccount, eq(usageLog.providerAccountId, providerAccount.id))
      .where(and(...durationConditions))
      .groupBy(providerAccount.provider, hourBucketExpression),
  ]);

  const statsByProvider = new Map<ProviderAccountKey, RawProviderStats>();

  for (const row of dailyUsageRows) {
    if (!isKnownProvider(row.provider)) continue;
    const date = toDate(row.dayBucket);
    if (!date) continue;
    const dayKey = date.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;

    const current = statsByProvider.get(row.provider) ?? createRawStats();
    const requestCount = toNumber(row.requestCount);
    const successCount = toNumber(row.successCount);
    current.totalRequests += requestCount;
    current.successfulRequests += successCount;
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    statsByProvider.set(row.provider, current);
  }

  for (const row of durationRows) {
    if (!isKnownProvider(row.provider)) continue;
    const date = toDate(row.hourBucket);
    if (!date) continue;
    const hourKey = date.toISOString();
    if (!hourKeySet.has(hourKey)) continue;

    const durationCount = toNumber(row.durationCount);
    const durationTotal = toNumber(row.durationTotal);
    if (durationCount <= 0) continue;

    const current = statsByProvider.get(row.provider) ?? createRawStats();
    const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
    durationBucket.total += durationTotal;
    durationBucket.count += durationCount;
    current.durationByHour.set(hourKey, durationBucket);
    statsByProvider.set(row.provider, current);
  }

  return { dayKeys, hourKeys, statsByProvider };
}

async function getCachedProviderSummaryStats(userId: string): Promise<Record<ProviderAccountKey, ProviderStats>> {
  const version = await getAnalyticsCacheVersion(userId);
  const cacheKey = `opendum:accounts:summary-stats:${userId}:v${version}`;
  const cached = await getRedisJson<Record<ProviderAccountKey, ProviderStats>>(cacheKey);
  if (cached) return cached;

  const providerUsage = await buildProviderStats(userId);
  const stats = Object.fromEntries(
    PROVIDER_ACCOUNT_KEYS.map((provider) => [
      provider,
      buildStatsFromRaw(providerUsage.statsByProvider.get(provider), providerUsage.dayKeys, providerUsage.hourKeys),
    ])
  ) as Record<ProviderAccountKey, ProviderStats>;

  await setRedisJson(cacheKey, stats, PROVIDER_SUMMARY_STATS_CACHE_TTL_SECONDS);
  return stats;
}

async function buildAccountStats(userId: string, accountIds: string[]): Promise<{ dayKeys: string[]; hourKeys: string[]; statsByAccountId: Map<string, RawProviderStats> }> {
  const dayKeys = buildDayKeys(PROVIDER_STATS_DAYS);
  const dayKeySet = new Set(dayKeys);
  const hourKeys = buildHourKeys(PROVIDER_DURATION_LOOKBACK_HOURS);
  const hourKeySet = new Set(hourKeys);
  const statsByAccountId = new Map<string, RawProviderStats>();
  if (accountIds.length === 0) return { dayKeys, hourKeys, statsByAccountId };

  const statsStartDate = new Date(`${dayKeys[0]}T00:00:00.000Z`);
  const durationStartDate = new Date(hourKeys[0] ?? Date.now());
  const dayBucketExpression = sql<Date>`date_trunc('day', ${usageLog.createdAt})`;
  const hourBucketExpression = sql<Date>`date_trunc('hour', ${usageLog.createdAt})`;
  const [dailyUsageRows, durationRows] = await Promise.all([
    db
      .select({ providerAccountId: usageLog.providerAccountId, dayBucket: dayBucketExpression, requestCount: sql<number>`count(*)`, successCount: sql<number>`count(*) filter (where ${usageLog.statusCode} >= 200 and ${usageLog.statusCode} < 400)` })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds), gte(usageLog.createdAt, statsStartDate)))
      .groupBy(usageLog.providerAccountId, dayBucketExpression),
    db
      .select({ providerAccountId: usageLog.providerAccountId, hourBucket: hourBucketExpression, durationTotal: sql<number>`coalesce(sum(${usageLog.duration}), 0)`, durationCount: sql<number>`count(${usageLog.duration})` })
      .from(usageLog)
      .where(and(eq(usageLog.userId, userId), inArray(usageLog.providerAccountId, accountIds), gte(usageLog.createdAt, durationStartDate)))
      .groupBy(usageLog.providerAccountId, hourBucketExpression),
  ]);

  for (const row of dailyUsageRows) {
    if (!row.providerAccountId) continue;
    const date = toDate(row.dayBucket);
    if (!date) continue;
    const dayKey = date.toISOString().split("T")[0] ?? "";
    if (!dayKeySet.has(dayKey)) continue;

    const current = statsByAccountId.get(row.providerAccountId) ?? createRawStats();
    const requestCount = toNumber(row.requestCount);
    const successCount = toNumber(row.successCount);
    current.totalRequests += requestCount;
    current.successfulRequests += successCount;
    current.dailyCounts.set(dayKey, (current.dailyCounts.get(dayKey) ?? 0) + requestCount);
    statsByAccountId.set(row.providerAccountId, current);
  }

  for (const row of durationRows) {
    if (!row.providerAccountId) continue;
    const date = toDate(row.hourBucket);
    if (!date) continue;
    const hourKey = date.toISOString();
    if (!hourKeySet.has(hourKey)) continue;

    const durationCount = toNumber(row.durationCount);
    const durationTotal = toNumber(row.durationTotal);
    if (durationCount <= 0) continue;

    const current = statsByAccountId.get(row.providerAccountId) ?? createRawStats();
    const durationBucket = current.durationByHour.get(hourKey) ?? { total: 0, count: 0 };
    durationBucket.total += durationTotal;
    durationBucket.count += durationCount;
    current.durationByHour.set(hourKey, durationBucket);
    statsByAccountId.set(row.providerAccountId, current);
  }

  return { dayKeys, hourKeys, statsByAccountId };
}

async function validateProviderApiKey(provider: ApiKeyProvider, apiKey: string): Promise<ActionResult<void>> {
  const { label, baseUrl, modelMap, validationPath, requireSuccessfulStatus } = API_KEY_PROVIDER_SETTINGS[provider];
  const validationModel = Object.values(modelMap)[0];
  if (validationPath === "/chat/completions" && !validationModel) return { success: false, error: `${label} API key validation model is not configured.` };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}${validationPath}`, { method: validationPath === "/chat/completions" ? "POST" : "GET", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, signal: controller.signal, cache: "no-store", body: validationPath === "/chat/completions" ? JSON.stringify({ model: validationModel, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }) : undefined });
    let responseText = "";
    if (response.status === 401 || response.status === 403 || (requireSuccessfulStatus && !response.ok)) {
      try { responseText = await response.text(); } catch { responseText = ""; }
    }
    if (response.status === 401 || response.status === 403) return { success: false, error: `${label} API key is invalid.` };
    if (requireSuccessfulStatus && !response.ok) {
      const normalizedBody = responseText.toLowerCase();
      if (normalizedBody.includes("authenticate") || normalizedBody.includes("unauthorized") || normalizedBody.includes("invalid api key") || normalizedBody.includes("user not found")) {
        return { success: false, error: `${label} API key is invalid.` };
      }
      return { success: false, error: `Unable to validate ${label} API key right now (HTTP ${response.status}). Please try again.` };
    }
    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: `${label} API key validation timed out. Please try again.` };
    return { success: false, error: `Unable to validate ${label} API key. Please check your network and try again.` };
  } finally {
    clearTimeout(timeout);
  }
}

async function connectApiKeyProviderAccount(userId: string, provider: ApiKeyProvider, apiKey: string, accountName?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) return { success: false, error: "API key is required" };
  const validationResult = await validateProviderApiKey(provider, normalizedApiKey);
  if (!validationResult.success) return validationResult;

  const { label } = API_KEY_PROVIDER_SETTINGS[provider];
  const identifier = `${provider}-${hashString(normalizedApiKey).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider), eq(providerAccount.email, identifier))).limit(1);

  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
  await db.insert(providerAccount).values({ userId, provider, name: normalizedAccountName || `${label} ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiKey), refreshToken: encrypt(normalizedApiKey), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, isActive: true });

  return { success: true, data: { email: identifier, isUpdate: false } };
}

async function connectWorkersAi(userId: string, apiToken: string, cfAccountId: string, accountName?: string): Promise<ActionResult<{ email: string; isUpdate: boolean }>> {
  const normalizedApiToken = apiToken.trim();
  const normalizedAccountId = cfAccountId.trim();
  if (!normalizedApiToken) return { success: false, error: "API token is required" };
  if (!normalizedAccountId) return { success: false, error: "Cloudflare Account ID is required" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_KEY_VALIDATION_TIMEOUT_MS);
  try {
    const response = await fetch(getWorkersAiValidationUrl(normalizedAccountId), { method: "GET", headers: { Authorization: `Bearer ${normalizedApiToken}`, Accept: "application/json" }, signal: controller.signal, cache: "no-store" });
    if (response.status === 401 || response.status === 403) return { success: false, error: "Workers AI API token is invalid." };
    if (!response.ok) return { success: false, error: `Unable to validate Workers AI credentials (HTTP ${response.status}). Please try again.` };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { success: false, error: "Workers AI validation timed out. Please try again." };
    return { success: false, error: "Unable to validate Workers AI credentials. Please check your network and try again." };
  } finally {
    clearTimeout(timeout);
  }

  const identifier = `workers_ai-${hashString(normalizedApiToken).slice(0, 16)}`;
  const normalizedAccountName = accountName?.trim();
  const [existingAccount] = await db.select().from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai"), eq(providerAccount.email, identifier))).limit(1);
  if (existingAccount) {
    await db.update(providerAccount).set({ accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, accountId: normalizedAccountId, ...(normalizedAccountName ? { name: normalizedAccountName } : {}), isActive: true }).where(eq(providerAccount.id, existingAccount.id));
    return { success: true, data: { email: identifier, isUpdate: true } };
  }

  const [countResult] = await db.select({ value: countFn() }).from(providerAccount).where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, "workers_ai")));
  await db.insert(providerAccount).values({ userId, provider: "workers_ai", name: normalizedAccountName || `Workers AI ${(countResult?.value ?? 0) + 1}`, accessToken: encrypt(normalizedApiToken), refreshToken: encrypt(normalizedApiToken), expiresAt: API_KEY_PROVIDER_ACCOUNT_EXPIRY, email: identifier, accountId: normalizedAccountId, isActive: true });
  return { success: true, data: { email: identifier, isUpdate: false } };
}

export async function listAccounts(userId: string) {
    try {
      return await db
        .select({
          id: providerAccount.id,
          provider: providerAccount.provider,
          name: providerAccount.name,
          email: providerAccount.email,
          isActive: providerAccount.isActive,
          lastUsedAt: providerAccount.lastUsedAt,
          expiresAt: providerAccount.expiresAt,
          requestCount: providerAccount.requestCount,
          tier: providerAccount.tier,
          status: providerAccount.status,
          statusReason: providerAccount.statusReason,
          errorCount: providerAccount.errorCount,
          consecutiveErrors: providerAccount.consecutiveErrors,
          lastErrorAt: providerAccount.lastErrorAt,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
          lastErrorMessage: providerAccount.lastErrorMessage,
          lastErrorCode: providerAccount.lastErrorCode,
          successCount: providerAccount.successCount,
          createdAt: providerAccount.createdAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId))
        .orderBy(asc(providerAccount.createdAt));
    } catch (error) {
      console.error("Failed to list accounts:", error);
      throw new Error("Failed to list accounts");
    }
}

export async function listAccountsByProvider(userId: string, input: z.infer<typeof providerInputSchema>) {
    try {
      return await db
        .select({
          id: providerAccount.id,
          provider: providerAccount.provider,
          name: providerAccount.name,
          email: providerAccount.email,
          isActive: providerAccount.isActive,
          lastUsedAt: providerAccount.lastUsedAt,
          expiresAt: providerAccount.expiresAt,
          requestCount: providerAccount.requestCount,
          tier: providerAccount.tier,
          status: providerAccount.status,
          statusReason: providerAccount.statusReason,
          errorCount: providerAccount.errorCount,
          consecutiveErrors: providerAccount.consecutiveErrors,
          lastErrorAt: providerAccount.lastErrorAt,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
          lastErrorMessage: providerAccount.lastErrorMessage,
          lastErrorCode: providerAccount.lastErrorCode,
          successCount: providerAccount.successCount,
          createdAt: providerAccount.createdAt,
        })
        .from(providerAccount)
        .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
        .orderBy(desc(providerAccount.createdAt));
    } catch (error) {
      console.error("Failed to list provider accounts:", error);
      throw new Error("Failed to list provider accounts");
    }
}

export async function createAccount(userId: string, input: z.infer<typeof createAccountInputSchema>) {
    const parsedProvider = apiKeyProviderSchema.safeParse(input.provider);
    if (parsedProvider.success) {
      return connectApiKeyProviderAccount(userId, parsedProvider.data, input.token, input.name);
    }

    if (input.provider === "workers_ai") {
      return connectWorkersAi(userId, input.token, input.cfAccountId ?? "", input.name);
    }

    return { success: false, error: `${input.provider} does not support direct API-key connection.` } as const;
}

export async function getAccountSummary(userId: string) {
  try {
    const [accounts, providerStats] = await Promise.all([
      db
        .select({
          provider: providerAccount.provider,
          isActive: providerAccount.isActive,
          lastErrorAt: providerAccount.lastErrorAt,
          lastSuccessAt: providerAccount.lastSuccessAt,
          lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
        })
        .from(providerAccount)
        .where(eq(providerAccount.userId, userId)),
      getCachedProviderSummaryStats(userId),
    ]);
    const pinnedProviders = await getPinnedProviderKeys(userId, accounts.map((account) => account.provider));

    const summaries = Object.fromEntries(
      PROVIDER_ACCOUNT_KEYS.map((provider) => [
        provider,
        {
          connected: 0,
          active: 0,
          indicator: "normal" as ProviderAccountIndicator,
          stats: providerStats[provider],
        },
      ])
    ) as Record<ProviderAccountKey, { connected: number; active: number; indicator: ProviderAccountIndicator; stats: ProviderStats }>;

    for (const account of accounts) {
      if (!isKnownProvider(account.provider)) continue;

      const summary = summaries[account.provider];
      summary.connected += 1;

      if (!account.isActive) continue;

      summary.active += 1;
      const indicator = getAccountIndicator(account.lastErrorAt, account.lastSuccessAt, account.lastRecoveredByRotationAt);
      if (INDICATOR_WEIGHT[indicator] > INDICATOR_WEIGHT[summary.indicator]) {
        summary.indicator = indicator;
      }
    }

    return { summaries, pinnedProviders };
  } catch (error) {
    console.error("Failed to load account summaries:", error);
    throw new Error("Failed to load account summaries");
  }
}

export async function getAccountsByProviderDetailed(userId: string, input: z.infer<typeof providerInputSchema>) {
  try {
    const accounts = await db
      .select({
        id: providerAccount.id,
        provider: providerAccount.provider,
        name: providerAccount.name,
        email: providerAccount.email,
        isActive: providerAccount.isActive,
        lastUsedAt: providerAccount.lastUsedAt,
        expiresAt: providerAccount.expiresAt,
        requestCount: providerAccount.requestCount,
        tier: providerAccount.tier,
        status: providerAccount.status,
        statusReason: providerAccount.statusReason,
        errorCount: providerAccount.errorCount,
        consecutiveErrors: providerAccount.consecutiveErrors,
        lastErrorAt: providerAccount.lastErrorAt,
        lastSuccessAt: providerAccount.lastSuccessAt,
        lastRecoveredByRotationAt: providerAccount.lastRecoveredByRotationAt,
        lastErrorMessage: providerAccount.lastErrorMessage,
        lastErrorCode: providerAccount.lastErrorCode,
        successCount: providerAccount.successCount,
        createdAt: providerAccount.createdAt,
      })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider)))
      .orderBy(desc(providerAccount.createdAt));

    const accountIds = accounts.map((account) => account.id);
    const [accountUsage, disabledModelRows, pinnedProviders] = await Promise.all([
      buildAccountStats(userId, accountIds),
      accountIds.length > 0
        ? db
            .select({ providerAccountId: providerAccountDisabledModel.providerAccountId, model: providerAccountDisabledModel.model })
            .from(providerAccountDisabledModel)
            .where(inArray(providerAccountDisabledModel.providerAccountId, accountIds))
        : Promise.resolve([]),
      getPinnedProviderKeys(userId),
    ]);

    const disabledModelsByAccountId = disabledModelRows.reduce<Record<string, string[]>>((acc, row) => {
      acc[row.providerAccountId] = [...(acc[row.providerAccountId] ?? []), row.model];
      return acc;
    }, {});

    return {
      accounts: accounts.map((account) => ({
        ...account,
        stats: buildStatsFromRaw(accountUsage.statsByAccountId.get(account.id), accountUsage.dayKeys, accountUsage.hourKeys),
      })),
      supportedModels: Array.from(getProviderModelSet(input.provider)).sort((a, b) => a.localeCompare(b)),
      disabledModelsByAccountId,
      pinnedProviders,
    };
  } catch (error) {
    console.error("Failed to load provider account detail:", error);
    throw new Error("Failed to load provider account detail");
  }
}

export async function updateAccount(userId: string, input: z.infer<typeof updateAccountInputSchema>) {
    try {
      const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.id), eq(providerAccount.userId, userId))).limit(1);
      if (!account) return { success: false, error: "Account not found" } as const;

      const updates: { name?: string; isActive?: boolean } = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) return { success: false, error: "Please enter a name" } as const;
        updates.name = name;
      }
      if (input.isActive !== undefined) updates.isActive = input.isActive;

      if (Object.keys(updates).length > 0) {
        await db.update(providerAccount).set(updates).where(eq(providerAccount.id, input.id));
        if (updates.isActive !== undefined) await invalidateDisabledModelsCache(userId);
      }

      return { success: true, data: undefined } as const;
    } catch (error) {
      console.error("Failed to update account:", error);
      return { success: false, error: "Failed to update account" } as const;
    }
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

      if (input.enabled) {
        await db.delete(providerAccountDisabledModel).where(and(eq(providerAccountDisabledModel.providerAccountId, account.id), inArray(providerAccountDisabledModel.model, getModelLookupKeys(normalizedModel))));
      } else {
        await db.insert(providerAccountDisabledModel).values({ providerAccountId: account.id, model: normalizedModel }).onConflictDoNothing({ target: [providerAccountDisabledModel.providerAccountId, providerAccountDisabledModel.model] });
      }

      await invalidateDisabledModelsCache(userId);
      return { success: true, data: { model: normalizedModel, enabled: input.enabled } } as const;
    } catch (error) {
      console.error("Failed to update account model status:", error);
      return { success: false, error: "Failed to update model status" } as const;
    }
}

export async function getAccountErrorHistory(userId: string, input: z.infer<typeof errorHistoryInputSchema>) {
    const [account] = await db.select({ id: providerAccount.id }).from(providerAccount).where(and(eq(providerAccount.id, input.accountId), eq(providerAccount.userId, userId))).limit(1);
    if (!account) return { success: false, error: "Account not found" } as const;

    const entries = await db
      .select({ id: providerAccountErrorHistory.id, errorCode: providerAccountErrorHistory.errorCode, errorMessage: providerAccountErrorHistory.errorMessage, createdAt: providerAccountErrorHistory.createdAt })
      .from(providerAccountErrorHistory)
      .where(eq(providerAccountErrorHistory.providerAccountId, input.accountId))
      .orderBy(desc(providerAccountErrorHistory.createdAt), desc(providerAccountErrorHistory.id))
      .limit(input.limit ?? 200);

    return { success: true, data: { entries } } as const;
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
        lastErrorMessage: null,
        lastErrorCode: null,
        lastRecoveredByRotationAt: null,
        ...(account.status === "degraded" || account.status === "failed" ? { status: "active", statusReason: null, statusChangedAt: new Date() } : {}),
      })
      .where(eq(providerAccount.id, input.accountId));
    await db.delete(providerAccountErrorHistory).where(eq(providerAccountErrorHistory.providerAccountId, input.accountId));
    await db.delete(providerAccountModelHealth).where(eq(providerAccountModelHealth.providerAccountId, input.accountId));
    return { success: true, data: undefined } as const;
  } catch (error) {
    console.error("Failed to resolve provider account errors:", error);
    return { success: false, error: "Failed to resolve account errors" } as const;
  }
}

export async function getAccountAuthUrl(input: z.infer<typeof getAuthUrlInputSchema>) {
  try {
    if (input.provider === "antigravity" || input.provider === "gemini_cli") {
      return { success: true, data: { authUrl: buildGoogleOAuthUrl(input.provider), state: null, codeVerifier: null } } as const;
    }

    const state = generateOAuthState();
    if (input.provider === "codex") {
      const codeVerifier = generateCodexCodeVerifier();
      const codeChallenge = await generateCodexCodeChallenge(codeVerifier);
      const params = new URLSearchParams({ response_type: "code", client_id: codexClientId, redirect_uri: codexBrowserRedirectUri, scope: codexScope, code_challenge: codeChallenge, code_challenge_method: "S256", id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: codexOriginator });
      return { success: true, data: { authUrl: `${codexAuthorizeEndpoint}?${params.toString()}`, state, codeVerifier } } as const;
    }

    const codeVerifier = generateKiroCodeVerifier();
    const authUrl = await buildKiroAuthUrl(state, codeVerifier);
    return { success: true, data: { authUrl, state, codeVerifier } } as const;
  } catch (error) {
    console.error("Failed to build provider auth URL:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to build login URL" } as const;
  }
}

export async function exchangeOAuthAccount(userId: string, input: z.infer<typeof exchangeOAuthInputSchema>) {
    try {
      const providerLabels: Record<OAuthProviderKey, string> = { antigravity: "Antigravity", gemini_cli: "Gemini CLI", codex: "Codex", kiro: "Kiro" };
      const parsedUrl = parseOAuthCallbackUrl(input.callbackUrl, providerLabels[input.provider]);
      if (!parsedUrl.success) return parsedUrl;

      if ((input.provider === "codex" || input.provider === "kiro") && parsedUrl.data.state !== input.state) {
        return { success: false, error: "Invalid OAuth state. Please restart authentication." } as const;
      }

      if ((input.provider === "codex" || input.provider === "kiro") && !input.codeVerifier) {
        return { success: false, error: "Missing authentication context. Please restart authentication." } as const;
      }

      if (input.provider === "antigravity") {
        return await upsertOAuthAccount(userId, "antigravity", "Antigravity", await antigravityProvider.exchangeCode(parsedUrl.data.code, antigravityRedirectUri));
      }

      if (input.provider === "gemini_cli") {
        return await upsertOAuthAccount(userId, "gemini_cli", "Gemini CLI", await geminiCliProvider.exchangeCode(parsedUrl.data.code, geminiCliRedirectUri));
      }

      if (input.provider === "codex") {
        const oauthResult = await codexProvider.exchangeCode(parsedUrl.data.code, codexBrowserRedirectUri, input.codeVerifier ?? undefined);
        const accountId = oauthResult.accountId || null;
        return await upsertOAuthAccount(userId, "codex", "Codex", oauthResult, { email: accountId ? `codex-${accountId}` : `codex-${Date.now()}`, accountId });
      }

      const oauthResult = await kiroProvider.exchangeCode(parsedUrl.data.code, kiroBrowserRedirectUri, input.codeVerifier ?? undefined);
      const accountId = oauthResult.accountId || null;
      return await upsertOAuthAccount(userId, "kiro", "Kiro", oauthResult, { email: accountId ? `kiro-${accountId}` : `kiro-${Date.now()}`, accountId });
    } catch (error) {
      console.error("Failed to exchange provider OAuth code:", error);
      return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
    }
}

export async function initiateDeviceAuth(input: z.infer<typeof initiateDeviceAuthInputSchema>) {
  try {
    const result = input.provider === "copilot" ? await initiateCopilotDeviceCodeFlow() : await initiateDeviceCodeFlow();
    return { success: true, data: result } as const;
  } catch (error) {
    console.error("Failed to initiate provider device auth:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to start device login" } as const;
  }
}

export async function pollDeviceAuth(userId: string, input: z.infer<typeof pollDeviceAuthInputSchema>) {
    try {
      const result = input.provider === "copilot" ? await pollCopilotDeviceCodeAuthorization(input.deviceCode) : await pollDeviceCodeAuthorization(input.deviceCode, input.codeVerifier ?? "");

      if ("pending" in result) {
        return { success: true, data: { status: "pending" as const, retryAfterSeconds: "retryAfterSeconds" in result ? result.retryAfterSeconds : undefined } } as const;
      }

      if ("error" in result) {
        return { success: true, data: { status: "error" as const, message: result.error } } as const;
      }

      const provider = input.provider;
      const label = provider === "copilot" ? "Copilot" : "Qwen Code";
      const email = result.email || `${provider === "copilot" ? "copilot" : "qwen"}-${Date.now()}`;
      const saved = await upsertOAuthAccount(userId, provider, label, result, { email });
      if (!saved.success) return saved;
      return { success: true, data: { status: "success" as const, ...saved.data } } as const;
    } catch (error) {
      console.error("Failed to poll provider device auth:", error);
      return { success: false, error: error instanceof Error ? error.message : "Failed to connect account" } as const;
    }
}
