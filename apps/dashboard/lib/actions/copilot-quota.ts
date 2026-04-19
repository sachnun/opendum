"use server";

import type { ProviderAccount } from "@opendum/shared/db/schema";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { providerAccount } from "@opendum/shared/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getRedisJson, setRedisJson } from "@opendum/shared/redis-cache";
import { copilotProvider } from "@opendum/shared/proxy/providers/copilot";
import {
  fetchCopilotUsageFromApi,
  type CopilotUsageSnapshot,
} from "@opendum/shared/proxy/providers/copilot/quota";

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
  accountId?: string;
}

const COPILOT_QUOTA_CACHE_PREFIX = "opendum:quota:copilot";
const COPILOT_QUOTA_CACHE_TTL_SECONDS = 45;
const COPILOT_DEFAULT_MONTHLY_LIMIT = 300;

function getCopilotQuotaCacheKey(userId: string): string {
  return `${COPILOT_QUOTA_CACHE_PREFIX}:${userId}`;
}

function resolveCopilotMonthlyLimit(detectedLimit?: number): {
  limit: number;
  estimated: boolean;
} {
  // Priority 1: Auto-detected from internal Copilot API (snapshot.planLimit)
  if (detectedLimit !== undefined && detectedLimit > 0) {
    return { limit: detectedLimit, estimated: false };
  }

  // Priority 2: Hardcoded default
  return { limit: COPILOT_DEFAULT_MONTHLY_LIMIT, estimated: true };
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

  // Determine confidence based on data source
  let confidence: "high" | "medium" | "low";
  if (!limitEstimated) {
    // Limit came from env var or was auto-detected from API
    confidence = "high";
  } else if (
    snapshot.source === "internal_api" ||
    snapshot.source === "both"
  ) {
    // We have internal API data but somehow no planLimit was detected —
    // still better than billing-only
    confidence = "medium";
  } else if (snapshot.source === "billing_api") {
    confidence = "medium";
  } else {
    confidence = "low";
  }

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
      resetInHuman: formatTimeUntilReset(snapshot.resetTimeIso),
      remainingLabel: `${toDisplayNumber(used)}/${toDisplayNumber(monthlyLimit)} used`,
    },
  ];
}

export async function getCopilotQuota(
  options: QuotaRequestOptions = {}
): Promise<CopilotQuotaActionResult> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const targetAccountId = options.accountId?.trim();
  const cacheKey = getCopilotQuotaCacheKey(session.user.id);
  if (!options.forceRefresh && !targetAccountId) {
    const cachedResult = await getRedisJson<CopilotQuotaActionResult>(cacheKey);
    if (cachedResult?.success) {
      return cachedResult;
    }
  }

  try {
    const accounts = await db
      .select({
        id: providerAccount.id,
        name: providerAccount.name,
        email: providerAccount.email,
        tier: providerAccount.tier,
        isActive: providerAccount.isActive,
        accessToken: providerAccount.accessToken,
        refreshToken: providerAccount.refreshToken,
        expiresAt: providerAccount.expiresAt,
        lastUsedAt: providerAccount.lastUsedAt,
      })
      .from(providerAccount)
      .where(
        and(
          eq(providerAccount.userId, session.user.id),
          eq(providerAccount.provider, "copilot"),
          ...(targetAccountId ? [eq(providerAccount.id, targetAccountId)] : [])
        )
      )
      .orderBy(desc(providerAccount.lastUsedAt));

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

      if (!targetAccountId) {
        await setRedisJson(cacheKey, emptyResult, COPILOT_QUOTA_CACHE_TTL_SECONDS);
      }
      return emptyResult;
    }

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
        // Resolve limit per-account: env override > auto-detected > default
        const { limit: accountLimit, estimated: accountLimitEstimated } =
          resolveCopilotMonthlyLimit(usageSnapshot.planLimit);

        const groups = toCopilotGroupDisplay(
          usageSnapshot,
          accountLimit,
          accountLimitEstimated
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

    if (!targetAccountId) {
      await setRedisJson(cacheKey, result, COPILOT_QUOTA_CACHE_TTL_SECONDS);
    }
    return result;
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : "Failed to fetch Copilot quota",
    };
  }
}
