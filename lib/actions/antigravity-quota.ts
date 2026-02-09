"use server";

/**
 * Server Actions for Antigravity Quota Monitoring
 */

import type { ProviderAccount } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/encryption";
import { 
  fetchQuotaFromApi, 
  QUOTA_GROUPS, 
  getMaxRequestsForModel,
  type QuotaGroupInfo 
} from "@/lib/proxy/providers/antigravity/quota";
import { antigravityProvider } from "@/lib/proxy/providers/antigravity/client";
import { 
  updateAllBaselines, 
  estimateRemainingQuota,
  incrementRequestCount as incrementCache,
  getAccountCacheData,
} from "@/lib/proxy/providers/antigravity/quota-cache";

// =============================================================================
// TYPES
// =============================================================================

export interface AccountQuotaInfo {
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

export interface QuotaGroupDisplay {
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
  resetInHuman: string | null; // e.g., "4h 32m"
}

export interface QuotaSummary {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<string, number>;
  exhaustedGroups: number;
  totalGroups: number;
}

export type QuotaActionResult =
  | { success: true; data: { accounts: AccountQuotaInfo[]; summary: QuotaSummary } }
  | { success: false; error: string };

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Format time remaining until reset in human-readable format
 */
function formatTimeUntilReset(resetTimestamp: number | null): string | null {
  if (!resetTimestamp) return null;
  
  const now = Date.now();
  const diff = resetTimestamp - now;
  
  if (diff <= 0) return "resetting...";
  
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

/**
 * Convert QuotaGroupInfo to display format with estimates
 */
function toQuotaGroupDisplay(
  group: QuotaGroupInfo,
  accountId: string,
  tier: string,
  useEstimate: boolean = false
): QuotaGroupDisplay {
  let remainingFraction = group.remainingFraction;
  let remainingRequests = group.remainingRequests;
  let isEstimated = false;
  let confidence: "high" | "medium" | "low" = "high";

  // If using estimates, get from cache
  if (useEstimate) {
    const estimate = estimateRemainingQuota(
      accountId,
      group.name,
      tier,
      group.maxRequests
    );
    
    if (estimate.isEstimated) {
      remainingFraction = estimate.remainingFraction;
      remainingRequests = estimate.remainingRequests;
      isEstimated = true;
      confidence = estimate.confidence;
    }
  }

  const usedRequests = group.maxRequests - remainingRequests;
  const percentUsed = group.maxRequests > 0 
    ? Math.round((usedRequests / group.maxRequests) * 100) 
    : 0;

  return {
    name: group.name,
    displayName: group.displayName,
    models: group.models,
    remainingFraction,
    remainingRequests,
    maxRequests: group.maxRequests,
    usedRequests,
    percentUsed,
    isExhausted: remainingFraction <= 0,
    isEstimated,
    confidence,
    resetTimeIso: group.resetTimeIso,
    resetInHuman: formatTimeUntilReset(group.resetTimestamp),
  };
}

// =============================================================================
// SERVER ACTIONS
// =============================================================================

/**
 * Get Antigravity quota for all user's accounts
 * 
 * This action fetches real-time quota from the Antigravity API and
 * updates the local cache for future estimations.
 */
export async function getAntigravityQuota(): Promise<QuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    // Get all Antigravity accounts for this user
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "antigravity",
      },
      select: {
        id: true,
        name: true,
        email: true,
        projectId: true,
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

    const results: AccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      // Count by tier
      const tier = account.tier ?? "free";
      byTier[tier] = (byTier[tier] ?? 0) + 1;

      // Get valid access token
      // Only refresh if token is ACTUALLY expired (no buffer, for quota monitor)
      let accessToken: string;
      const isActuallyExpired = account.expiresAt && new Date(account.expiresAt) < new Date();

      if (isActuallyExpired) {
        // Token expired - try to refresh
        try {
          accessToken = await antigravityProvider.getValidCredentials(
            account as unknown as ProviderAccount
          );
        } catch {
          // Refresh failed - token is truly dead
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
      } else {
        // Token still valid - just decrypt (fast path)
        try {
          accessToken = decrypt(account.accessToken);
        } catch {
          results.push({
            accountId: account.id,
            accountName: account.name,
            email: account.email,
            tier,
            isActive: account.isActive,
            status: "error",
            error: "Failed to decrypt credentials",
            groups: [],
            fetchedAt: Date.now(),
            lastUsedAt: account.lastUsedAt?.getTime() ?? null,
          });
          continue;
        }
      }

      // Fetch quota from API
      const quotaResult = await fetchQuotaFromApi(
        accessToken,
        account.projectId ?? "",
        tier
      );

      if (quotaResult.status === "error") {
        results.push({
          accountId: account.id,
          accountName: account.name,
          email: account.email,
          tier,
          isActive: account.isActive,
          status: "error",
          error: quotaResult.error,
          groups: [],
          fetchedAt: quotaResult.fetchedAt,
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      // Update cache baselines
      updateAllBaselines(
        account.id,
        quotaResult.groups.map((g) => ({
          name: g.name,
          remainingFraction: g.remainingFraction,
          resetTimestamp: g.resetTimestamp,
        }))
      );

      // Convert to display format
      const groups = quotaResult.groups.map((g) =>
        toQuotaGroupDisplay(g, account.id, tier, false)
      );

      // Count exhausted groups
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
        fetchedAt: quotaResult.fetchedAt,
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
      error: error instanceof Error ? error.message : "Failed to fetch quota data",
    };
  }
}

/**
 * Get estimated quota (uses cache, doesn't hit API)
 * 
 * Use this for quick updates between full API fetches.
 */
export async function getEstimatedQuota(): Promise<QuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "antigravity",
      },
      select: {
        id: true,
        name: true,
        email: true,
        tier: true,
        isActive: true,
        lastUsedAt: true,
      },
      orderBy: { lastUsedAt: "desc" },
    });

    const results: AccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      const tier = account.tier ?? "free";
      byTier[tier] = (byTier[tier] ?? 0) + 1;

      // Build groups from constants with estimates
      const groups: QuotaGroupDisplay[] = [];
      
      for (const [groupName, groupConfig] of Object.entries(QUOTA_GROUPS)) {
        const representativeModel = groupConfig.models[0];
        const maxRequests = getMaxRequestsForModel(representativeModel, tier);
        
        const estimate = estimateRemainingQuota(
          account.id,
          groupName,
          tier,
          maxRequests
        );

        const usedRequests = maxRequests - estimate.remainingRequests;
        const percentUsed = maxRequests > 0 
          ? Math.round((usedRequests / maxRequests) * 100) 
          : 0;

        groups.push({
          name: groupName,
          displayName: groupConfig.displayName,
          models: groupConfig.models,
          remainingFraction: estimate.remainingFraction,
          remainingRequests: estimate.remainingRequests,
          maxRequests: estimate.maxRequests,
          usedRequests,
          percentUsed,
          isExhausted: estimate.isExhausted,
          isEstimated: estimate.isEstimated,
          confidence: estimate.confidence,
          resetTimeIso: null,
          resetInHuman: null,
        });

        totalGroups++;
        if (estimate.isExhausted) {
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

    return {
      success: true,
      data: {
        accounts: results,
        summary: {
          totalAccounts: accounts.length,
          activeAccounts: accounts.filter((account) => account.isActive).length,
          byTier,
          exhaustedGroups,
          totalGroups,
        },
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get quota estimates",
    };
  }
}

/**
 * Increment request count for an account/model (called after successful request)
 */
export async function incrementRequestCount(
  accountId: string,
  model: string
): Promise<void> {
  // Update in-memory cache
  incrementCache(accountId, model);
  
  // Also update database request count
  try {
    await prisma.providerAccount.update({
      where: { id: accountId },
      data: {
        requestCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  } catch (error) {
    void error;
  }
}

/**
 * Get cache debug info for an account
 */
export async function getQuotaCacheDebug(accountId: string): Promise<{
  baselines: Record<string, unknown>;
  requestCounts: Record<string, number>;
} | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  // Verify user owns this account
  const account = await prisma.providerAccount.findFirst({
    where: { id: accountId, userId: session.user.id },
    select: { id: true },
  });

  if (!account) {
    return null;
  }

  return getAccountCacheData(accountId);
}
