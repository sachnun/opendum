"use server";

import type { ProviderAccount } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { openRouterProvider } from "@/lib/proxy/providers/openrouter";
import { OPENROUTER_API_BASE_URL } from "@/lib/proxy/providers/openrouter/constants";

const OPENROUTER_REQUEST_TIMEOUT_MS = 10000;

type JsonRecord = Record<string, unknown>;

interface OpenRouterKeyInfo {
  isFreeTier: boolean | null;
  limit: number | null;
  limitRemaining: number | null;
  limitReset: string | null;
  usage: number | null;
  usageDaily: number | null;
  usageWeekly: number | null;
  usageMonthly: number | null;
}

interface OpenRouterCreditsInfo {
  totalCredits: number | null;
  totalUsage: number | null;
  remainingCredits: number | null;
}

export interface OpenRouterQuotaGroupDisplay {
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
  confidence: "high" | "medium" | "low";
  resetTimeIso: string | null;
  resetInHuman: string | null;
  remainingLabel?: string;
}

export interface OpenRouterAccountQuotaInfo {
  accountId: string;
  accountName: string;
  email: string | null;
  tier: string;
  isActive: boolean;
  status: "success" | "error" | "expired";
  error?: string;
  groups: OpenRouterQuotaGroupDisplay[];
  fetchedAt: number;
  lastUsedAt: number | null;
}

export interface OpenRouterQuotaSummary {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<string, number>;
  exhaustedGroups: number;
  totalGroups: number;
}

export type OpenRouterQuotaActionResult =
  | {
      success: true;
      data: {
        accounts: OpenRouterAccountQuotaInfo[];
        summary: OpenRouterQuotaSummary;
      };
    }
  | { success: false; error: string };

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as JsonRecord;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  return null;
}

function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTimeUntilReset(resetTimestamp: number | null): string | null {
  if (!resetTimestamp) {
    return null;
  }

  const diff = resetTimestamp - Date.now();
  if (diff <= 0) {
    return "resetting...";
  }

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

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

function getNextResetTimestamp(limitReset: string | null): number | null {
  if (!limitReset) {
    return null;
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();

  if (limitReset === "daily") {
    return Date.UTC(year, month, day + 1, 0, 0, 0, 0);
  }

  if (limitReset === "weekly") {
    const currentDay = now.getUTCDay();
    const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay;
    return Date.UTC(year, month, day + daysUntilMonday, 0, 0, 0, 0);
  }

  if (limitReset === "monthly") {
    return Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
  }

  return null;
}

async function fetchOpenRouterJson(
  path: "/key" | "/credits",
  apiKey: string
): Promise<{ ok: true; data: JsonRecord } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OPENROUTER_API_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });

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
      return {
        ok: false,
        error: `OpenRouter${path} request failed: HTTP ${response.status}${suffix}`,
      };
    }

    const bodyRecord = asRecord(parsedBody);
    const dataRecord = asRecord(bodyRecord?.data);

    if (!dataRecord) {
      return {
        ok: false,
        error: `OpenRouter${path} response did not include a data object`,
      };
    }

    return { ok: true, data: dataRecord };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        ok: false,
        error: `OpenRouter${path} request timed out`,
      };
    }

    return {
      ok: false,
      error: error instanceof Error ? error.message : `Failed to fetch OpenRouter${path}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseKeyInfo(data: JsonRecord): OpenRouterKeyInfo {
  return {
    isFreeTier: toBoolean(data.is_free_tier),
    limit: toNumber(data.limit),
    limitRemaining: toNumber(data.limit_remaining),
    limitReset: toStringValue(data.limit_reset),
    usage: toNumber(data.usage),
    usageDaily: toNumber(data.usage_daily),
    usageWeekly: toNumber(data.usage_weekly),
    usageMonthly: toNumber(data.usage_monthly),
  };
}

function parseCreditsInfo(data: JsonRecord): OpenRouterCreditsInfo {
  const totalCredits = toNumber(data.total_credits);
  const totalUsage = toNumber(data.total_usage);
  const remainingCredits =
    totalCredits !== null && totalUsage !== null
      ? Math.max(0, totalCredits - totalUsage)
      : null;

  return {
    totalCredits,
    totalUsage,
    remainingCredits,
  };
}

function buildQuotaGroups(
  keyInfo: OpenRouterKeyInfo | null,
  creditsInfo: OpenRouterCreditsInfo | null
): OpenRouterQuotaGroupDisplay[] {
  const groups: OpenRouterQuotaGroupDisplay[] = [];

  if (
    creditsInfo &&
    creditsInfo.totalCredits !== null &&
    creditsInfo.totalCredits > 0 &&
    creditsInfo.remainingCredits !== null &&
    creditsInfo.totalUsage !== null
  ) {
    const remainingFraction = clampFraction(
      creditsInfo.remainingCredits / creditsInfo.totalCredits
    );
    const usedCredits = Math.max(0, creditsInfo.totalCredits - creditsInfo.remainingCredits);

    groups.push({
      name: "account-credits",
      displayName: "Account credits",
      models: [],
      remainingFraction,
      remainingRequests: Number(creditsInfo.remainingCredits.toFixed(2)),
      maxRequests: Number(creditsInfo.totalCredits.toFixed(2)),
      usedRequests: Number(usedCredits.toFixed(2)),
      percentUsed: Math.round(clampFraction(usedCredits / creditsInfo.totalCredits) * 100),
      isExhausted: remainingFraction <= 0,
      isEstimated: false,
      confidence: "high",
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `${formatUsd(creditsInfo.remainingCredits)} / ${formatUsd(creditsInfo.totalCredits)}`,
    });
  }

  if (
    keyInfo &&
    keyInfo.limit !== null &&
    keyInfo.limit > 0 &&
    keyInfo.limitRemaining !== null &&
    keyInfo.usage !== null
  ) {
    const remainingFraction = clampFraction(keyInfo.limitRemaining / keyInfo.limit);
    const usedLimit = Math.max(0, keyInfo.limit - keyInfo.limitRemaining);
    const resetTimestamp = getNextResetTimestamp(keyInfo.limitReset);

    groups.push({
      name: "key-limit",
      displayName: "API key limit",
      models: [],
      remainingFraction,
      remainingRequests: Number(keyInfo.limitRemaining.toFixed(2)),
      maxRequests: Number(keyInfo.limit.toFixed(2)),
      usedRequests: Number(usedLimit.toFixed(2)),
      percentUsed: Math.round(clampFraction(usedLimit / keyInfo.limit) * 100),
      isExhausted: remainingFraction <= 0,
      isEstimated: false,
      confidence: "high",
      resetTimeIso: resetTimestamp ? new Date(resetTimestamp).toISOString() : null,
      resetInHuman: formatTimeUntilReset(resetTimestamp),
      remainingLabel: `${formatUsd(keyInfo.limitRemaining)} / ${formatUsd(keyInfo.limit)}`,
    });
  }

  if (groups.length > 0) {
    return groups;
  }

  if (keyInfo?.usageDaily !== null && keyInfo?.usageDaily !== undefined) {
    groups.push({
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
      remainingLabel: formatUsd(keyInfo.usageDaily),
    });

    return groups;
  }

  groups.push({
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
    remainingLabel: keyInfo?.isFreeTier ? "free tier" : "active",
  });

  return groups;
}

export async function getOpenRouterQuota(): Promise<OpenRouterQuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "openrouter",
      },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
        lastUsedAt: true,
      },
      orderBy: { lastUsedAt: "desc" },
    });

    if (accounts.length === 0) {
      return {
        success: true,
        data: {
          accounts: [],
          summary: {
            totalAccounts: 0,
            activeAccounts: 0,
            byTier: {},
            exhaustedGroups: 0,
            totalGroups: 0,
          },
        },
      };
    }

    const results: OpenRouterAccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      let apiKey: string;
      try {
        apiKey = await openRouterProvider.getValidCredentials(
          account as unknown as ProviderAccount
        );
      } catch {
        byTier.unknown = (byTier.unknown ?? 0) + 1;
        results.push({
          accountId: account.id,
          accountName: account.name,
          email: account.email,
          tier: "unknown",
          isActive: account.isActive,
          status: "expired",
          error: "API key is missing or invalid. Please reconnect this account.",
          groups: [],
          fetchedAt: Date.now(),
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      const [keyResponse, creditsResponse] = await Promise.all([
        fetchOpenRouterJson("/key", apiKey),
        fetchOpenRouterJson("/credits", apiKey),
      ]);

      if (!keyResponse.ok && !creditsResponse.ok) {
        byTier.unknown = (byTier.unknown ?? 0) + 1;
        results.push({
          accountId: account.id,
          accountName: account.name,
          email: account.email,
          tier: "unknown",
          isActive: account.isActive,
          status: "error",
          error: keyResponse.error,
          groups: [],
          fetchedAt: Date.now(),
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      const keyInfo = keyResponse.ok ? parseKeyInfo(keyResponse.data) : null;
      const creditsInfo = creditsResponse.ok ? parseCreditsInfo(creditsResponse.data) : null;
      const tier = keyInfo?.isFreeTier ? "free" : "paid";
      byTier[tier] = (byTier[tier] ?? 0) + 1;

      const groups = buildQuotaGroups(keyInfo, creditsInfo);
      for (const group of groups) {
        totalGroups++;
        if (group.isExhausted) {
          exhaustedGroups++;
        }
      }

      results.push({
        accountId: account.id,
        accountName: account.name,
        email: account.email,
        tier,
        isActive: account.isActive,
        status: "success",
        groups,
        fetchedAt: Date.now(),
        lastUsedAt: account.lastUsedAt?.getTime() ?? null,
      });
    }

    const activeAccountCount = results.filter((account) => account.isActive).length;

    return {
      success: true,
      data: {
        accounts: results,
        summary: {
          totalAccounts: results.length,
          activeAccounts: activeAccountCount,
          byTier,
          exhaustedGroups,
          totalGroups,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch OpenRouter quota",
    };
  }
}
