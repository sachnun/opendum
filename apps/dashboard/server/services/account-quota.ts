import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../lib/db";
import { providerAccount, type ProviderAccount } from "../lib/db/schema";
import { decrypt } from "../lib/encryption";
import { fetchInternalProvider, InternalRelayNotConfiguredError } from "../lib/proxy/internal-relay";
import { antigravityProvider } from "../lib/providers/antigravity";
import { fetchQuotaFromApi as fetchAntigravityQuotaFromApi, type QuotaGroupInfo as AntigravityQuotaGroupInfo } from "../lib/providers/antigravity/quota";
import { codexProvider } from "../lib/providers/codex";
import { fetchCodexQuotaFromApi, type CodexQuotaSnapshot, type CodexRateLimitWindow } from "../lib/providers/codex/quota";
import { copilotProvider } from "../lib/providers/copilot";
import { fetchCopilotUsageFromApi, type CopilotUsageSnapshot } from "../lib/providers/copilot/quota";
import { fetchGeminiCliAccountInfo, geminiCliProvider } from "../lib/providers/gemini-cli/client";
import { fetchGeminiCliQuotaFromApi, type GeminiCliQuotaGroupInfo, type GeminiCliQuotaSnapshot } from "../lib/providers/gemini-cli/quota";
import { kiroProvider } from "../lib/providers/kiro";
import { fetchKiroQuotaFromApi, type KiroQuotaMetric } from "../lib/providers/kiro/quota";
import { API_BASE_URL as openRouterApiBaseUrl } from "../lib/providers/openrouter/constants";

export const accountQuotaInputSchema = z.object({ provider: z.enum(["antigravity", "copilot", "codex", "gemini_cli", "kiro", "openrouter"]), accountId: z.string(), forceRefresh: z.boolean().optional() });
const OPENROUTER_REQUEST_TIMEOUT_MS = 10000;
const COPILOT_DEFAULT_MONTHLY_LIMIT = 300;

type QuotaProviderKey = z.infer<typeof accountQuotaInputSchema>["provider"];
type QuotaConfidence = "high" | "medium" | "low";
type JsonRecord = Record<string, unknown>;
type QuotaFetcher = (account: ProviderAccount) => Promise<AccountQuotaInfo>;

interface QuotaGroupDisplay {
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
  confidence: QuotaConfidence;
  resetTimeIso: string | null;
  resetInHuman: string | null;
  remainingLabel?: string;
}

interface AccountQuotaInfo {
  accountId: string;
  accountName: string;
  email: string | null;
  tier: string;
  isActive: boolean;
  status: "success" | "error" | "expired";
  error?: string;
  groups: QuotaGroupDisplay[];
  fetchedAt: number;
  lastUsedAt: number | null;
}

function formatTimeUntilReset(resetTimestamp: number | null): string | null {
  if (!resetTimestamp) return null;

  const diff = resetTimestamp - Date.now();
  if (diff <= 0) return "resetting...";

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatTimeUntilResetIso(resetTimeIso: string | null): string | null {
  if (!resetTimeIso) return null;
  const resetTimestamp = new Date(resetTimeIso).getTime();
  return Number.isFinite(resetTimestamp) ? formatTimeUntilReset(resetTimestamp) : null;
}

function toDisplayNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.abs(value - Math.round(value)) < 0.001 ? Math.round(value) : Number(value.toFixed(2));
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function toBaseQuotaInfo(account: ProviderAccount, tier: string, status: AccountQuotaInfo["status"], groups: QuotaGroupDisplay[], fetchedAt: number, error?: string): AccountQuotaInfo {
  return {
    accountId: account.id,
    accountName: account.name,
    email: account.email,
    tier,
    isActive: account.isActive,
    status,
    ...(error ? { error } : {}),
    groups,
    fetchedAt,
    lastUsedAt: account.lastUsedAt?.getTime() ?? null,
  };
}

function expiredQuotaInfo(account: ProviderAccount, tier: string, error: string): AccountQuotaInfo {
  return toBaseQuotaInfo(account, tier, "expired", [], Date.now(), error);
}

function errorQuotaInfo(account: ProviderAccount, tier: string, error: string, fetchedAt = Date.now()): AccountQuotaInfo {
  return toBaseQuotaInfo(account, tier, "error", [], fetchedAt, error);
}

function toAntigravityGroupDisplay(group: AntigravityQuotaGroupInfo): QuotaGroupDisplay {
  const usedRequests = group.maxRequests - group.remainingRequests;
  const percentUsed = group.maxRequests > 0 ? Math.round((usedRequests / group.maxRequests) * 100) : 0;

  return {
    name: group.name,
    displayName: group.displayName,
    models: group.models,
    remainingFraction: group.remainingFraction,
    remainingLabel: `${Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)))}%`,
    remainingRequests: group.remainingRequests,
    maxRequests: group.maxRequests,
    usedRequests,
    percentUsed,
    isExhausted: group.remainingFraction <= 0,
    isEstimated: true,
    confidence: "medium",
    resetTimeIso: group.resetTimeIso,
    resetInHuman: formatTimeUntilReset(group.resetTimestamp),
  };
}

function toGeminiCliGroupDisplay(group: GeminiCliQuotaGroupInfo, isEstimated: boolean, confidence: QuotaConfidence): QuotaGroupDisplay {
  const usedRequests = Math.max(0, group.maxRequests - group.remainingRequests);
  const percentUsed = group.maxRequests > 0 ? Math.round((usedRequests / group.maxRequests) * 100) : 0;

  return {
    name: group.name,
    displayName: group.displayName,
    models: group.models,
    remainingFraction: group.remainingFraction,
    remainingRequests: group.remainingRequests,
    maxRequests: group.maxRequests,
    usedRequests,
    percentUsed,
    isExhausted: group.isExhausted,
    isEstimated,
    confidence,
    resetTimeIso: group.resetTimeIso,
    resetInHuman: formatTimeUntilReset(group.resetTimestamp),
  };
}

function geminiCliSnapshotToGroups(snapshot: GeminiCliQuotaSnapshot, isEstimated: boolean, confidence: QuotaConfidence): QuotaGroupDisplay[] {
  return snapshot.groups.map((group) => toGeminiCliGroupDisplay(group, isEstimated, confidence));
}

function resolveCopilotMonthlyLimit(detectedLimit?: number): { limit: number; estimated: boolean } {
  if (detectedLimit !== undefined && detectedLimit > 0) return { limit: detectedLimit, estimated: false };
  return { limit: COPILOT_DEFAULT_MONTHLY_LIMIT, estimated: true };
}

function formatMonthLabel(year: number, month: number): string {
  const date = new Date(Date.UTC(year, Math.max(0, month - 1), 1));
  return date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
}

function copilotSnapshotToGroups(snapshot: CopilotUsageSnapshot, monthlyLimit: number, limitEstimated: boolean): QuotaGroupDisplay[] {
  if (snapshot.status !== "success") return [];

  const used = Math.max(0, snapshot.totalRequests);
  const remaining = Math.max(0, monthlyLimit - used);
  const remainingFraction = monthlyLimit > 0 ? clampFraction(remaining / monthlyLimit) : 0;
  const percentUsed = monthlyLimit > 0 ? Math.max(0, Math.min(100, Math.round((used / monthlyLimit) * 100))) : 0;
  const monthLabel = formatMonthLabel(snapshot.year, snapshot.month);
  const confidence: QuotaConfidence = !limitEstimated ? "high" : snapshot.source === "internal_api" || snapshot.source === "both" || snapshot.source === "billing_api" ? "medium" : "low";

  return [
    {
      name: "premium_requests",
      displayName: `Premium requests (${monthLabel})`,
      models: snapshot.modelUsage.map((entry) => entry.model),
      remainingFraction,
      remainingRequests: toDisplayNumber(remaining),
      maxRequests: toDisplayNumber(monthlyLimit),
      usedRequests: toDisplayNumber(used),
      percentUsed,
      isExhausted: remainingFraction <= 0,
      isEstimated: limitEstimated,
      confidence,
      resetTimeIso: snapshot.resetTimeIso,
      resetInHuman: formatTimeUntilResetIso(snapshot.resetTimeIso),
      remainingLabel: `${toDisplayNumber(used)}/${toDisplayNumber(monthlyLimit)} used`,
    },
  ];
}

function formatWindowDuration(windowMinutes: number | null): string | null {
  if (!windowMinutes || windowMinutes <= 0) return null;
  if (windowMinutes % (24 * 60) === 0) return `${windowMinutes / (24 * 60)}d`;
  if (windowMinutes >= 60) {
    const hours = Math.floor(windowMinutes / 60);
    const minutes = windowMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${windowMinutes}m`;
}

function getWindowDisplayName(name: "primary" | "secondary", windowMinutes: number | null, tier?: string | null): string {
  const normalizedTier = tier?.trim().toLowerCase() ?? "";

  if (name === "secondary") return normalizedTier.includes("free") ? "Weekly usage (free)" : "Weekly usage";

  const duration = formatWindowDuration(windowMinutes);
  if (duration === "7d" && normalizedTier.includes("free")) return "Weekly usage (free)";
  return duration === "5h" ? "5 hour usage" : duration ? `${duration} usage` : "Usage";
}

function toCodexGroupDisplay(name: "primary" | "secondary", window: CodexRateLimitWindow, isEstimated: boolean, confidence: QuotaConfidence, tier?: string | null): QuotaGroupDisplay {
  const maxRequests = 100;
  const remainingRequests = Math.max(0, Math.min(maxRequests, Math.round(window.remainingPercent)));
  const usedRequests = Math.max(0, maxRequests - remainingRequests);
  const resetTimeIso = window.resetTimestamp ? new Date(window.resetTimestamp).toISOString() : null;

  return {
    name,
    displayName: getWindowDisplayName(name, window.windowMinutes, tier),
    models: [],
    remainingFraction: window.remainingFraction,
    remainingRequests,
    maxRequests,
    usedRequests,
    percentUsed: Math.round(window.usedPercent),
    isExhausted: window.isExhausted,
    isEstimated,
    confidence,
    resetTimeIso,
    resetInHuman: formatTimeUntilReset(window.resetTimestamp),
  };
}

function codexSnapshotToGroups(snapshot: CodexQuotaSnapshot, isEstimated: boolean, confidence: QuotaConfidence, tier?: string | null): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  if (snapshot.primary) groups.push(toCodexGroupDisplay("primary", snapshot.primary, isEstimated, confidence, tier));
  if (snapshot.secondary) groups.push(toCodexGroupDisplay("secondary", snapshot.secondary, isEstimated, confidence, tier));
  return groups;
}

function toKiroGroupDisplay(metric: KiroQuotaMetric): QuotaGroupDisplay {
  const usageLimitRaw = Math.max(0, metric.usageLimit);
  const usedRaw = Math.max(0, Math.min(usageLimitRaw, metric.currentUsage));
  const remainingRaw = Math.max(0, usageLimitRaw - usedRaw);
  const remainingFraction = usageLimitRaw > 0 ? clampFraction(remainingRaw / usageLimitRaw) : 0;
  const percentUsedRaw = metric.percentUsed ?? (usageLimitRaw > 0 ? (usedRaw / usageLimitRaw) * 100 : 0);

  return {
    name: metric.name.toLowerCase(),
    displayName: metric.displayName,
    models: [],
    remainingFraction,
    remainingRequests: toDisplayNumber(remainingRaw),
    maxRequests: toDisplayNumber(usageLimitRaw),
    usedRequests: toDisplayNumber(usedRaw),
    percentUsed: Math.round(Math.max(0, Math.min(100, percentUsedRaw))),
    isExhausted: remainingFraction <= 0,
    isEstimated: false,
    confidence: "high",
    resetTimeIso: metric.resetTimeIso,
    resetInHuman: formatTimeUntilResetIso(metric.resetTimeIso),
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? (value as JsonRecord) : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function getNextOpenRouterResetTimestamp(limitReset: string | null): number | null {
  if (!limitReset) return null;

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  if (limitReset === "daily") return Date.UTC(year, month, day + 1, 0, 0, 0, 0);
  if (limitReset === "weekly") {
    const currentDay = now.getUTCDay();
    const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay;
    return Date.UTC(year, month, day + daysUntilMonday, 0, 0, 0, 0);
  }
  if (limitReset === "monthly") return Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  return null;
}

async function fetchOpenRouterJson(path: "/key" | "/credits", apiKey: string): Promise<{ ok: true; data: JsonRecord } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchInternalProvider(`${openRouterApiBaseUrl}${path}`, { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" }, signal: controller.signal });
    const rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = null;
      }
    }

    if (!response.ok) {
      const suffix = rawBody ? ` ${rawBody.slice(0, 250)}` : "";
      return { ok: false, error: `OpenRouter${path} request failed: HTTP ${response.status}${suffix}` };
    }

    const dataRecord = asRecord(asRecord(parsedBody)?.data);
    if (!dataRecord) return { ok: false, error: `OpenRouter${path} response did not include a data object` };
    return { ok: true, data: dataRecord };
  } catch (error) {
    if (error instanceof InternalRelayNotConfiguredError) return { ok: false, error: "Proxy URL is required to fetch OpenRouter quota. Set NUXT_PUBLIC_PROXY_URL to your Railway proxy URL." };
    if (error instanceof Error && error.name === "AbortError") return { ok: false, error: `OpenRouter${path} request timed out` };
    return { ok: false, error: error instanceof Error ? error.message : `Failed to fetch OpenRouter${path}` };
  } finally {
    clearTimeout(timeout);
  }
}

function buildOpenRouterQuotaGroups(keyData: JsonRecord | null, creditsData: JsonRecord | null): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const totalCredits = toNumber(creditsData?.total_credits);
  const totalUsage = toNumber(creditsData?.total_usage);
  const remainingCredits = totalCredits !== null && totalUsage !== null ? Math.max(0, totalCredits - totalUsage) : null;

  if (totalCredits !== null && totalCredits > 0 && remainingCredits !== null && totalUsage !== null) {
    const remainingFraction = clampFraction(remainingCredits / totalCredits);
    const usedCredits = Math.max(0, totalCredits - remainingCredits);
    groups.push({
      name: "account-credits",
      displayName: "Account credits",
      models: [],
      remainingFraction,
      remainingRequests: Number(remainingCredits.toFixed(2)),
      maxRequests: Number(totalCredits.toFixed(2)),
      usedRequests: Number(usedCredits.toFixed(2)),
      percentUsed: Math.round(clampFraction(usedCredits / totalCredits) * 100),
      isExhausted: remainingFraction <= 0,
      isEstimated: false,
      confidence: "high",
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `${formatUsd(remainingCredits)} / ${formatUsd(totalCredits)}`,
    });
  }

  const limit = toNumber(keyData?.limit);
  const limitRemaining = toNumber(keyData?.limit_remaining);
  const usage = toNumber(keyData?.usage);
  if (limit !== null && limit > 0 && limitRemaining !== null && usage !== null) {
    const remainingFraction = clampFraction(limitRemaining / limit);
    const usedLimit = Math.max(0, limit - limitRemaining);
    const resetTimestamp = getNextOpenRouterResetTimestamp(toStringValue(keyData?.limit_reset));
    groups.push({
      name: "key-limit",
      displayName: "API key limit",
      models: [],
      remainingFraction,
      remainingRequests: Number(limitRemaining.toFixed(2)),
      maxRequests: Number(limit.toFixed(2)),
      usedRequests: Number(usedLimit.toFixed(2)),
      percentUsed: Math.round(clampFraction(usedLimit / limit) * 100),
      isExhausted: remainingFraction <= 0,
      isEstimated: false,
      confidence: "high",
      resetTimeIso: resetTimestamp ? new Date(resetTimestamp).toISOString() : null,
      resetInHuman: formatTimeUntilReset(resetTimestamp),
      remainingLabel: `${formatUsd(limitRemaining)} / ${formatUsd(limit)}`,
    });
  }

  if (groups.length > 0) return groups;

  const usageDaily = toNumber(keyData?.usage_daily);
  if (usageDaily !== null) {
    return [
      {
        name: "daily-usage",
        displayName: "Today usage",
        models: [],
        remainingFraction: 1,
        remainingRequests: 1,
        maxRequests: 1,
        usedRequests: 0,
        percentUsed: 0,
        isExhausted: false,
        isEstimated: true,
        confidence: "medium",
        resetTimeIso: null,
        resetInHuman: "resets daily",
        remainingLabel: formatUsd(usageDaily),
      },
    ];
  }

  return [
    {
      name: "key-status",
      displayName: "OpenRouter key",
      models: [],
      remainingFraction: 1,
      remainingRequests: 1,
      maxRequests: 1,
      usedRequests: 0,
      percentUsed: 0,
      isExhausted: false,
      isEstimated: true,
      confidence: "low",
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: toBoolean(keyData?.is_free_tier) ? "free tier" : "active",
    },
  ];
}

async function getValidQuotaCredentials(account: ProviderAccount, getCredentials: (account: ProviderAccount) => Promise<string>, fallbackTier: string): Promise<{ accessToken: string } | AccountQuotaInfo> {
  try {
    return { accessToken: await getCredentials(account) };
  } catch {
    return expiredQuotaInfo(account, fallbackTier, "Token expired - please re-authenticate");
  }
}

async function getAntigravityQuota(account: ProviderAccount): Promise<AccountQuotaInfo> {
  const tier = account.tier ?? "free";
  const credentials = await getValidQuotaCredentials(account, (account) => antigravityProvider.getValidCredentials(account), tier);
  if ("status" in credentials) return credentials;
  const quota = await fetchAntigravityQuotaFromApi(credentials.accessToken, account.projectId ?? "", tier);
  if (quota.status === "error") return errorQuotaInfo(account, tier, quota.error, quota.fetchedAt);
  return toBaseQuotaInfo(account, tier, "success", quota.groups.map(toAntigravityGroupDisplay), quota.fetchedAt);
}

async function getCopilotQuota(account: ProviderAccount): Promise<AccountQuotaInfo> {
  const tier = account.tier?.trim() || "free";
  const credentials = await getValidQuotaCredentials(account, (account) => copilotProvider.getValidCredentials(account), tier);
  if ("status" in credentials) return credentials;
  const snapshot = await fetchCopilotUsageFromApi(credentials.accessToken);
  if (snapshot.status !== "success") return errorQuotaInfo(account, tier, snapshot.error, snapshot.fetchedAt);
  const { limit, estimated } = resolveCopilotMonthlyLimit(snapshot.planLimit);
  return toBaseQuotaInfo(account, tier, "success", copilotSnapshotToGroups(snapshot, limit, estimated), snapshot.fetchedAt);
}

async function getCodexQuota(account: ProviderAccount): Promise<AccountQuotaInfo> {
  const fallbackTier = account.tier?.trim() || "free";
  const credentials = await getValidQuotaCredentials(account, (account) => codexProvider.getValidCredentials(account), fallbackTier);
  if ("status" in credentials) return credentials;
  const snapshot = await fetchCodexQuotaFromApi(credentials.accessToken, account.accountId);
  if (snapshot.status !== "success") return errorQuotaInfo(account, fallbackTier, snapshot.error ?? "Failed to fetch Codex quota data", Date.now());
  const tier = snapshot.planType?.trim() || fallbackTier;
  return toBaseQuotaInfo(account, tier, "success", codexSnapshotToGroups(snapshot, false, "high", tier), snapshot.fetchedAt);
}

async function getGeminiCliQuota(account: ProviderAccount): Promise<AccountQuotaInfo> {
  const credentials = await getValidQuotaCredentials(account, (account) => geminiCliProvider.getValidCredentials(account), account.tier ?? "free-tier");
  if ("status" in credentials) return credentials;

  let projectId = account.projectId;
  let tier = account.tier ?? "free-tier";
  let projectDiscoveryError: string | undefined;

  if (!projectId) {
    try {
      const accountInfo = await fetchGeminiCliAccountInfo(credentials.accessToken);
      projectDiscoveryError = accountInfo.error;
      if (accountInfo.projectId) {
        projectId = accountInfo.projectId;
        tier = accountInfo.tier || tier;
        projectDiscoveryError = undefined;
        await db.update(providerAccount).set({ projectId: accountInfo.projectId, tier, email: accountInfo.email || account.email }).where(eq(providerAccount.id, account.id));
      }
    } catch {
      projectDiscoveryError = "Failed to discover Gemini CLI project ID";
    }
  }

  if (!projectId) {
    return errorQuotaInfo(account, tier, projectDiscoveryError ?? "Gemini CLI account is missing projectId. Re-authenticate this account or set GEMINI_CLI_PROJECT_ID.");
  }

  const snapshot = await fetchGeminiCliQuotaFromApi(credentials.accessToken, projectId, tier);
  if (snapshot.status !== "success") return errorQuotaInfo(account, tier, snapshot.error ?? "Failed to fetch Gemini CLI quota data", snapshot.fetchedAt);
  return toBaseQuotaInfo(account, snapshot.tier, "success", geminiCliSnapshotToGroups(snapshot, false, "high"), snapshot.fetchedAt);
}

async function getKiroQuota(account: ProviderAccount): Promise<AccountQuotaInfo> {
  const fallbackTier = account.tier?.trim() || "free";
  const credentials = await getValidQuotaCredentials(account, (account) => kiroProvider.getValidCredentials(account), fallbackTier);
  if ("status" in credentials) return credentials;
  const snapshot = await fetchKiroQuotaFromApi(credentials.accessToken, account.accountId);
  const tier = snapshot.tier?.trim() || fallbackTier;
  if (snapshot.status !== "success") return errorQuotaInfo(account, tier, snapshot.error ?? "Failed to fetch Kiro quota data", snapshot.fetchedAt);
  return toBaseQuotaInfo(account, tier, "success", snapshot.metrics.map(toKiroGroupDisplay), snapshot.fetchedAt);
}

async function getOpenRouterQuota(account: ProviderAccount): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = decrypt(account.accessToken);
  } catch {
    return expiredQuotaInfo(account, "unknown", "API key is missing or invalid. Please reconnect this account.");
  }

  const [keyResponse, creditsResponse] = await Promise.all([fetchOpenRouterJson("/key", apiKey), fetchOpenRouterJson("/credits", apiKey)]);
  if (!keyResponse.ok && !creditsResponse.ok) return errorQuotaInfo(account, "unknown", keyResponse.error);

  const keyData = keyResponse.ok ? keyResponse.data : null;
  const creditsData = creditsResponse.ok ? creditsResponse.data : null;
  const tier = toBoolean(keyData?.is_free_tier) ? "free" : "paid";
  return toBaseQuotaInfo(account, tier, "success", buildOpenRouterQuotaGroups(keyData, creditsData), Date.now());
}

const QUOTA_FETCHERS = {
  antigravity: getAntigravityQuota,
  copilot: getCopilotQuota,
  codex: getCodexQuota,
  gemini_cli: getGeminiCliQuota,
  kiro: getKiroQuota,
  openrouter: getOpenRouterQuota,
} satisfies Record<QuotaProviderKey, QuotaFetcher>;

export async function getAccountQuota(userId: string, input: z.infer<typeof accountQuotaInputSchema>) {
  try {
    const [account] = await db
      .select()
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, input.provider), eq(providerAccount.id, input.accountId)))
      .orderBy(desc(providerAccount.lastUsedAt))
      .limit(1);

    if (!account) return { success: false, error: "Account not found" } as const;
    return { success: true, data: await QUOTA_FETCHERS[input.provider](account) } as const;
  } catch (error) {
    console.error("Failed to fetch provider quota:", error);
    return { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota data" } as const;
  }
}
