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
  type QuotaGroupInfo 
} from "@/lib/proxy/providers/antigravity/quota";
import { antigravityProvider } from "@/lib/proxy/providers/antigravity/client";

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
 * Convert QuotaGroupInfo to display format
 */
function toQuotaGroupDisplay(group: QuotaGroupInfo): QuotaGroupDisplay {
  const usedRequests = group.maxRequests - group.remainingRequests;
  const percentUsed = group.maxRequests > 0 
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
    isExhausted: group.remainingFraction <= 0,
    isEstimated: false,
    confidence: "high",
    resetTimeIso: group.resetTimeIso,
    resetInHuman: formatTimeUntilReset(group.resetTimestamp),
  };
}

// =============================================================================
// SERVER ACTIONS
// =============================================================================

/**
 * Get Antigravity quota for all user's accounts
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

      // Convert to display format
      const groups = quotaResult.groups.map((g) => toQuotaGroupDisplay(g));

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
