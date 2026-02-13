"use server";

import type { ProviderAccount } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getRedisJson, setRedisJson } from "@/lib/redis-cache";
import { copilotProvider } from "@/lib/proxy/providers/copilot";
import {
  fetchCopilotUsageFromApi,
  type CopilotUsageSnapshot,
} from "@/lib/proxy/providers/copilot/quota";

export interface CopilotQuotaGroupDisplay {
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

export interface CopilotAccountQuotaInfo {
  accountId: string;
  accountName: string;
  email: string | null;
  tier: string;
  isActive: boolean;
  status: "success" | "error" | "expired";
  error?: string;
  groups: CopilotQuotaGroupDisplay[];
  fetchedAt: number;
  lastUsedAt: number | null;
}

export interface CopilotQuotaSummary {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<string, number>;
  exhaustedGroups: number;
  totalGroups: number;
}

export type CopilotQuotaActionResult =
  | {
      success: true;
      data: {
        accounts: CopilotAccountQuotaInfo[];
        summary: CopilotQuotaSummary;
      };
    }
  | { success: false; error: string };

interface QuotaRequestOptions {
  forceRefresh?: boolean;
}

const COPILOT_QUOTA_CACHE_PREFIX = "opendum:quota:copilot";
const COPILOT_QUOTA_CACHE_TTL_SECONDS = 45;
const COPILOT_DEFAULT_MONTHLY_LIMIT = 300;

function getCopilotQuotaCacheKey(userId: string): string {
  return `${COPILOT_QUOTA_CACHE_PREFIX}:${userId}`;
}

function resolveCopilotMonthlyLimit(): { limit: number; estimated: boolean } {
  const rawValue =
    process.env.COPILOT_PREMIUM_REQUEST_LIMIT ?? process.env.GH_COPILOT_LIMIT;

  if (!rawValue) {
    return { limit: COPILOT_DEFAULT_MONTHLY_LIMIT, estimated: true };
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { limit: COPILOT_DEFAULT_MONTHLY_LIMIT, estimated: true };
  }

  return { limit: parsed, estimated: false };
}

function toDisplayNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (Math.abs(value - Math.round(value)) < 0.001) {
    return Math.round(value);
  }

  return Number(value.toFixed(2));
}

function formatTimeUntilReset(resetTimeIso: string | null): string | null {
  if (!resetTimeIso) {
    return null;
  }

  const resetTimestamp = new Date(resetTimeIso).getTime();
  if (!Number.isFinite(resetTimestamp)) {
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

function formatMonthLabel(year: number, month: number): string {
  const date = new Date(Date.UTC(year, Math.max(0, month - 1), 1));
  return date.toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
}

function toCopilotGroupDisplay(
  snapshot: CopilotUsageSnapshot,
  monthlyLimit: number,
  limitEstimated: boolean
): CopilotQuotaGroupDisplay[] {
  if (snapshot.status !== "success") {
    return [];
  }

  const used = Math.max(0, snapshot.totalRequests);
  const remaining = Math.max(0, monthlyLimit - used);
  const remainingFraction =
    monthlyLimit > 0 ? Math.max(0, Math.min(1, remaining / monthlyLimit)) : 0;
  const percentUsed =
    monthlyLimit > 0
      ? Math.max(0, Math.min(100, Math.round((used / monthlyLimit) * 100)))
      : 0;
  const monthLabel = formatMonthLabel(snapshot.year, snapshot.month);

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
      confidence: limitEstimated ? "medium" : "high",
      resetTimeIso: snapshot.resetTimeIso,
      resetInHuman: formatTimeUntilReset(snapshot.resetTimeIso),
      remainingLabel: `${toDisplayNumber(used)}/${toDisplayNumber(monthlyLimit)} used`,
    },
  ];
}

export async function getCopilotQuota(
  options: QuotaRequestOptions = {}
): Promise<CopilotQuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const cacheKey = getCopilotQuotaCacheKey(session.user.id);
  if (!options.forceRefresh) {
    const cachedResult = await getRedisJson<CopilotQuotaActionResult>(cacheKey);
    if (cachedResult?.success) {
      return cachedResult;
    }
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "copilot",
      },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        isActive: true,
        accessToken: true,
        refreshToken: true,
        expiresAt: true,
        lastUsedAt: true,
      },
      orderBy: { lastUsedAt: "desc" },
    });

    if (accounts.length === 0) {
      const emptyResult: CopilotQuotaActionResult = {
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

      await setRedisJson(cacheKey, emptyResult, COPILOT_QUOTA_CACHE_TTL_SECONDS);
      return emptyResult;
    }

    const { limit: monthlyLimit, estimated: limitEstimated } =
      resolveCopilotMonthlyLimit();

    const results: CopilotAccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      const tier = account.tier ?? "unknown";
      byTier[tier] = (byTier[tier] ?? 0) + 1;

      let accessToken: string;
      try {
        accessToken = await copilotProvider.getValidCredentials(
          account as unknown as ProviderAccount
        );
      } catch {
        results.push({
          accountId: account.id,
          accountName: account.name,
          email: account.email,
          tier,
          isActive: account.isActive,
          status: "expired",
          error: "Token expired - please re-authenticate",
          groups: [],
          fetchedAt: Date.now(),
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      const usageSnapshot = await fetchCopilotUsageFromApi(accessToken);

      if (usageSnapshot.status === "success") {
        const groups = toCopilotGroupDisplay(
          usageSnapshot,
          monthlyLimit,
          limitEstimated
        );

        for (const group of groups) {
          totalGroups += 1;
          if (group.isExhausted) {
            exhaustedGroups += 1;
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
          fetchedAt: usageSnapshot.fetchedAt,
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      results.push({
        accountId: account.id,
        accountName: account.name,
        email: account.email,
        tier,
        isActive: account.isActive,
        status: "error",
        error: usageSnapshot.error,
        groups: [],
        fetchedAt: usageSnapshot.fetchedAt,
        lastUsedAt: account.lastUsedAt?.getTime() ?? null,
      });
    }

    const activeAccountCount = results.filter((account) => account.isActive).length;

    const result: CopilotQuotaActionResult = {
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

    await setRedisJson(cacheKey, result, COPILOT_QUOTA_CACHE_TTL_SECONDS);
    return result;
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to fetch Copilot quota",
    };
  }
}
