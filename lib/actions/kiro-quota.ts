"use server";

import type { ProviderAccount } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getRedisJson, setRedisJson } from "@/lib/redis-cache";
import { kiroProvider } from "@/lib/proxy/providers/kiro";
import {
  fetchKiroQuotaFromApi,
  type KiroQuotaMetric,
} from "@/lib/proxy/providers/kiro/quota";

export interface KiroQuotaGroupDisplay {
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
}

export interface KiroAccountQuotaInfo {
  accountId: string;
  accountName: string;
  email: string | null;
  tier: string;
  isActive: boolean;
  status: "success" | "error" | "expired";
  error?: string;
  groups: KiroQuotaGroupDisplay[];
  fetchedAt: number;
  lastUsedAt: number | null;
}

export interface KiroQuotaSummary {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<string, number>;
  exhaustedGroups: number;
  totalGroups: number;
}

export type KiroQuotaActionResult =
  | {
      success: true;
      data: {
        accounts: KiroAccountQuotaInfo[];
        summary: KiroQuotaSummary;
      };
    }
  | { success: false; error: string };

interface QuotaRequestOptions {
  forceRefresh?: boolean;
}

const KIRO_QUOTA_CACHE_PREFIX = "opendum:quota:kiro";
const KIRO_QUOTA_CACHE_TTL_SECONDS = 45;

function getKiroQuotaCacheKey(userId: string): string {
  return `${KIRO_QUOTA_CACHE_PREFIX}:${userId}`;
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

function toDisplayNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (Math.abs(value - Math.round(value)) < 0.001) {
    return Math.round(value);
  }

  return Number(value.toFixed(2));
}

function toQuotaGroupDisplay(metric: KiroQuotaMetric): KiroQuotaGroupDisplay {
  const usageLimitRaw = Math.max(0, metric.usageLimit);
  const usedRaw = Math.max(0, Math.min(usageLimitRaw, metric.currentUsage));
  const remainingRaw = Math.max(0, usageLimitRaw - usedRaw);
  const remainingFraction =
    usageLimitRaw > 0 ? Math.max(0, Math.min(1, remainingRaw / usageLimitRaw)) : 0;
  const percentUsedRaw =
    metric.percentUsed ??
    (usageLimitRaw > 0 ? (usedRaw / usageLimitRaw) * 100 : 0);

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
    resetInHuman: formatTimeUntilReset(metric.resetTimeIso),
  };
}

export async function getKiroQuota(
  options: QuotaRequestOptions = {}
): Promise<KiroQuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const cacheKey = getKiroQuotaCacheKey(session.user.id);
  if (!options.forceRefresh) {
    const cachedResult = await getRedisJson<KiroQuotaActionResult>(cacheKey);
    if (cachedResult?.success) {
      return cachedResult;
    }
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "kiro",
      },
      select: {
        id: true,
        name: true,
        email: true,
        accountId: true,
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
      const emptyResult: KiroQuotaActionResult = {
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

      await setRedisJson(cacheKey, emptyResult, KIRO_QUOTA_CACHE_TTL_SECONDS);
      return emptyResult;
    }

    const results: KiroAccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      let accessToken: string;
      try {
        accessToken = await kiroProvider.getValidCredentials(
          account as unknown as ProviderAccount
        );
      } catch {
        const tier = account.tier ?? "unknown";
        byTier[tier] = (byTier[tier] ?? 0) + 1;

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

      const liveQuota = await fetchKiroQuotaFromApi(accessToken, account.accountId);
      const tier = liveQuota.tier ?? account.tier ?? "unknown";
      byTier[tier] = (byTier[tier] ?? 0) + 1;

      if (liveQuota.status === "success") {
        const groups = liveQuota.metrics.map((metric) =>
          toQuotaGroupDisplay(metric)
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
          fetchedAt: liveQuota.fetchedAt,
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
        error: liveQuota.error ?? "Failed to fetch Kiro quota data",
        groups: [],
        fetchedAt: liveQuota.fetchedAt,
        lastUsedAt: account.lastUsedAt?.getTime() ?? null,
      });
    }

    const activeAccountCount = results.filter((account) => account.isActive).length;

    const result: KiroQuotaActionResult = {
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

    await setRedisJson(cacheKey, result, KIRO_QUOTA_CACHE_TTL_SECONDS);
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to fetch Kiro quota",
    };
  }
}
