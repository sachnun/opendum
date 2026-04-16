"use server";

import type { ProviderAccount } from "@opendum/shared/db/schema";
import { getSession } from "@/lib/auth";
import { db } from "@opendum/shared/db";
import { providerAccount } from "@opendum/shared/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getRedisJson, setRedisJson } from "@opendum/shared/redis-cache";
import {
  geminiCliProvider,
  fetchGeminiCliAccountInfo,
} from "@opendum/shared/proxy/providers/gemini-cli/client";
import {
  fetchGeminiCliQuotaFromApi,
  type GeminiCliQuotaGroupInfo,
  type GeminiCliQuotaSnapshot,
} from "@opendum/shared/proxy/providers/gemini-cli/quota";

export interface GeminiCliQuotaGroupDisplay {
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

export interface GeminiCliAccountQuotaInfo {
  accountId: string;
  accountName: string;
  email: string | null;
  tier: string;
  isActive: boolean;
  status: "success" | "error" | "expired";
  error?: string;
  groups: GeminiCliQuotaGroupDisplay[];
  fetchedAt: number;
  lastUsedAt: number | null;
}

export interface GeminiCliQuotaSummary {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<string, number>;
  exhaustedGroups: number;
  totalGroups: number;
}

export type GeminiCliQuotaActionResult =
  | {
      success: true;
      data: {
        accounts: GeminiCliAccountQuotaInfo[];
        summary: GeminiCliQuotaSummary;
      };
    }
  | { success: false; error: string };

interface QuotaRequestOptions {
  forceRefresh?: boolean;
  accountId?: string;
}

const GEMINI_CLI_QUOTA_CACHE_PREFIX = "opendum:quota:gemini-cli";
const GEMINI_CLI_QUOTA_CACHE_TTL_SECONDS = 45;

function getGeminiCliQuotaCacheKey(userId: string): string {
  return `${GEMINI_CLI_QUOTA_CACHE_PREFIX}:${userId}`;
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

function toQuotaGroupDisplay(
  group: GeminiCliQuotaGroupInfo,
  isEstimated: boolean,
  confidence: "high" | "medium" | "low"
): GeminiCliQuotaGroupDisplay {
  const usedRequests = Math.max(0, group.maxRequests - group.remainingRequests);
  const percentUsed =
    group.maxRequests > 0
      ? Math.round((usedRequests / group.maxRequests) * 100)
      : 0;

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

function snapshotToGroups(
  snapshot: GeminiCliQuotaSnapshot,
  isEstimated: boolean,
  confidence: "high" | "medium" | "low"
): GeminiCliQuotaGroupDisplay[] {
  return snapshot.groups.map((group) =>
    toQuotaGroupDisplay(group, isEstimated, confidence)
  );
}

export async function getGeminiCliQuota(
  options: QuotaRequestOptions = {}
): Promise<GeminiCliQuotaActionResult> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  const targetAccountId = options.accountId?.trim();
  const cacheKey = getGeminiCliQuotaCacheKey(session.user.id);
  if (!options.forceRefresh && !targetAccountId) {
    const cachedResult = await getRedisJson<GeminiCliQuotaActionResult>(cacheKey);
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
        projectId: providerAccount.projectId,
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
          eq(providerAccount.provider, "gemini_cli"),
          ...(targetAccountId ? [eq(providerAccount.id, targetAccountId)] : [])
        )
      )
      .orderBy(desc(providerAccount.lastUsedAt));

    if (accounts.length === 0) {
      const emptyResult: GeminiCliQuotaActionResult = {
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
        await setRedisJson(cacheKey, emptyResult, GEMINI_CLI_QUOTA_CACHE_TTL_SECONDS);
      }
      return emptyResult;
    }

    const results: GeminiCliAccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      let accessToken: string;
      try {
        accessToken = await geminiCliProvider.getValidCredentials(
          account as unknown as ProviderAccount
        );
      } catch {
        const tier = account.tier ?? "free-tier";
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

      const [refreshedMeta] = await db
        .select({
          projectId: providerAccount.projectId,
          tier: providerAccount.tier,
        })
        .from(providerAccount)
        .where(eq(providerAccount.id, account.id))
        .limit(1);

      let projectId = refreshedMeta?.projectId ?? account.projectId;
      let tier = refreshedMeta?.tier ?? account.tier ?? "free-tier";
      let projectDiscoveryError: string | undefined;

      if (!projectId) {
        try {
          const accountInfo = await fetchGeminiCliAccountInfo(accessToken);
          projectDiscoveryError = accountInfo.error;

          if (accountInfo.projectId) {
            projectId = accountInfo.projectId;
            tier = accountInfo.tier || tier;
            projectDiscoveryError = undefined;

            await db
              .update(providerAccount)
              .set({
                projectId: accountInfo.projectId,
                tier,
                email: accountInfo.email || account.email,
              })
              .where(eq(providerAccount.id, account.id));
          }
        } catch {
        }
      }

      if (!projectId) {
        byTier[tier] = (byTier[tier] ?? 0) + 1;
        results.push({
          accountId: account.id,
          accountName: account.name,
          email: account.email,
          tier,
          isActive: account.isActive,
          status: "error",
          error:
            projectDiscoveryError ??
            "Gemini CLI account is missing projectId. Re-authenticate this account or set GEMINI_CLI_PROJECT_ID.",
          groups: [],
          fetchedAt: Date.now(),
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      const liveQuota = await fetchGeminiCliQuotaFromApi(accessToken, projectId, tier);

      if (liveQuota.status === "success") {
        byTier[liveQuota.tier] = (byTier[liveQuota.tier] ?? 0) + 1;
        const groups = snapshotToGroups(liveQuota, false, "high");

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
          tier: liveQuota.tier,
          isActive: account.isActive,
          status: "success",
          groups,
          fetchedAt: liveQuota.fetchedAt,
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      byTier[tier] = (byTier[tier] ?? 0) + 1;
      results.push({
        accountId: account.id,
        accountName: account.name,
        email: account.email,
        tier,
        isActive: account.isActive,
        status: "error",
        error: liveQuota.error ?? "Failed to fetch Gemini CLI quota data",
        groups: [],
        fetchedAt: Date.now(),
        lastUsedAt: account.lastUsedAt?.getTime() ?? null,
      });
    }

    const activeAccountCount = results.filter((account) => account.isActive).length;

    const result: GeminiCliQuotaActionResult = {
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
      await setRedisJson(cacheKey, result, GEMINI_CLI_QUOTA_CACHE_TTL_SECONDS);
    }
    return result;
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to fetch Gemini CLI quota",
    };
  }
}
