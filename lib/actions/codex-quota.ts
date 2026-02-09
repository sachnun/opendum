"use server";

/**
 * Server Actions for Codex quota monitoring.
 */

import type { ProviderAccount } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { codexProvider } from "@/lib/proxy/providers/codex";
import {
  fetchCodexQuotaFromApi,
  getCodexQuotaSnapshot,
  isCodexQuotaStale,
  setCodexQuotaSnapshot,
  type CodexQuotaSnapshot,
  type CodexRateLimitWindow,
} from "@/lib/proxy/providers/codex/quota";

export interface CodexQuotaGroupDisplay {
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

export interface CodexAccountQuotaInfo {
  accountId: string;
  accountName: string;
  email: string | null;
  tier: string;
  isActive: boolean;
  status: "success" | "error" | "expired";
  error?: string;
  groups: CodexQuotaGroupDisplay[];
  fetchedAt: number;
  lastUsedAt: number | null;
}

export interface CodexQuotaSummary {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<string, number>;
  exhaustedGroups: number;
  totalGroups: number;
}

export type CodexQuotaActionResult =
  | {
      success: true;
      data: { accounts: CodexAccountQuotaInfo[]; summary: CodexQuotaSummary };
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

function formatWindowDuration(windowMinutes: number | null): string | null {
  if (!windowMinutes || windowMinutes <= 0) {
    return null;
  }

  if (windowMinutes % (24 * 60) === 0) {
    return `${windowMinutes / (24 * 60)}d`;
  }

  if (windowMinutes >= 60) {
    const hours = Math.floor(windowMinutes / 60);
    const minutes = windowMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return `${windowMinutes}m`;
}

function getWindowDisplayName(
  name: "primary" | "secondary",
  windowMinutes: number | null
): string {
  const base = name === "primary" ? "Primary window" : "Secondary window";
  const duration = formatWindowDuration(windowMinutes);
  return duration ? `${base} (${duration})` : base;
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
  name: "primary" | "secondary",
  window: CodexRateLimitWindow,
  isEstimated: boolean,
  confidence: "high" | "medium" | "low"
): CodexQuotaGroupDisplay {
  const maxRequests = 100;
  const remainingRequests = Math.max(0, Math.min(maxRequests, Math.round(window.remainingPercent)));
  const usedRequests = Math.max(0, maxRequests - remainingRequests);
  const resetTimeIso = window.resetTimestamp
    ? new Date(window.resetTimestamp).toISOString()
    : null;

  return {
    name,
    displayName: getWindowDisplayName(name, window.windowMinutes),
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

function snapshotToGroups(
  snapshot: CodexQuotaSnapshot,
  isEstimated: boolean,
  confidence: "high" | "medium" | "low"
): CodexQuotaGroupDisplay[] {
  const groups: CodexQuotaGroupDisplay[] = [];

  if (snapshot.primary) {
    groups.push(toQuotaGroupDisplay("primary", snapshot.primary, isEstimated, confidence));
  }

  if (snapshot.secondary) {
    groups.push(toQuotaGroupDisplay("secondary", snapshot.secondary, isEstimated, confidence));
  }

  return groups;
}

export async function getCodexQuota(): Promise<CodexQuotaActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const accounts = await prisma.providerAccount.findMany({
      where: {
        userId: session.user.id,
        provider: "codex",
      },
      select: {
        id: true,
        name: true,
        email: true,
        accountId: true,
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

    const results: CodexAccountQuotaInfo[] = [];
    let exhaustedGroups = 0;
    let totalGroups = 0;
    const byTier: Record<string, number> = {};

    for (const account of accounts) {
      let accessToken: string;
      try {
        accessToken = await codexProvider.getValidCredentials(
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
          error: "Token expired - please re-authenticate",
          groups: [],
          fetchedAt: Date.now(),
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      const liveQuota = await fetchCodexQuotaFromApi(accessToken, account.accountId);

      if (liveQuota.status === "success") {
        setCodexQuotaSnapshot(account.id, liveQuota);

        const tier = liveQuota.planType ?? "unknown";
        byTier[tier] = (byTier[tier] ?? 0) + 1;

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
          tier,
          isActive: account.isActive,
          status: "success",
          groups,
          fetchedAt: liveQuota.fetchedAt,
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      const cachedQuota = getCodexQuotaSnapshot(account.id);
      if (cachedQuota && !isCodexQuotaStale(cachedQuota)) {
        const tier = cachedQuota.planType ?? "unknown";
        byTier[tier] = (byTier[tier] ?? 0) + 1;

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
          tier,
          isActive: account.isActive,
          status: "success",
          error: liveQuota.error,
          groups,
          fetchedAt: cachedQuota.fetchedAt,
          lastUsedAt: account.lastUsedAt?.getTime() ?? null,
        });
        continue;
      }

      byTier.unknown = (byTier.unknown ?? 0) + 1;
      results.push({
        accountId: account.id,
        accountName: account.name,
        email: account.email,
        tier: "unknown",
        isActive: account.isActive,
        status: "error",
        error: liveQuota.error ?? "Failed to fetch Codex quota data",
        groups: [],
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
      error: error instanceof Error ? error.message : "Failed to fetch Codex quota",
    };
  }
}
