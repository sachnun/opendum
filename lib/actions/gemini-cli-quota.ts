"use server";

import type { ProviderAccount } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  geminiCliProvider,
  fetchGeminiCliAccountInfo,
} from "@/lib/proxy/providers/gemini-cli/client";
import {
  fetchGeminiCliQuotaFromApi,
  getGeminiCliQuotaSnapshot,
  isGeminiCliQuotaStale,
  setGeminiCliQuotaSnapshot,
  type GeminiCliQuotaGroupInfo,
  type GeminiCliQuotaSnapshot,
} from "@/lib/proxy/providers/gemini-cli/quota";

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

function getConfidenceFromAge(ageMs: number): "high" | "medium" | "low" {
  if (ageMs < 5 * 60 * 1000) {
    return "high";
  }

  if (ageMs < 30 * 60 * 1000) {
    return "medium";
  }

  return "low";
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

export async function getGeminiCliQuota(): Promise<GeminiCliQuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "gemini_cli",
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

    const results: GeminiCliAccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      if (!account.isActive) {
        continue;
      }

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

      const refreshedMeta = await prisma.providerAccount.findUnique({
        where: { id: account.id },
        select: { projectId: true, tier: true },
      });

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

            await prisma.providerAccount.update({
              where: { id: account.id },
              data: {
                projectId: accountInfo.projectId,
                tier,
                email: accountInfo.email || account.email,
              },
            });
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
        setGeminiCliQuotaSnapshot(account.id, liveQuota);

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

      const cachedQuota = getGeminiCliQuotaSnapshot(account.id);
      if (cachedQuota && !isGeminiCliQuotaStale(cachedQuota)) {
        byTier[cachedQuota.tier] = (byTier[cachedQuota.tier] ?? 0) + 1;
        const ageMs = Math.max(0, Date.now() - cachedQuota.fetchedAt);
        const confidence = getConfidenceFromAge(ageMs);
        const groups = snapshotToGroups(cachedQuota, true, confidence);

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
          tier: cachedQuota.tier,
          isActive: account.isActive,
          status: "success",
          error: liveQuota.error,
          groups,
          fetchedAt: cachedQuota.fetchedAt,
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

    return {
      success: true,
      data: {
        accounts: results,
        summary: {
          totalAccounts: results.length,
          activeAccounts: results.length,
          byTier,
          exhaustedGroups,
          totalGroups,
        },
      },
    };
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
