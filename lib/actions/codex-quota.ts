"use server";

/**
 * Server Actions for Codex quota monitoring.
 */

import { Effect } from "effect";
import { DatabaseService, RedisService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, RedisError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";
import type { ProviderAccount } from "@/lib/db/schema";
import { providerAccount } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { codexProvider } from "@/lib/proxy/providers/codex";
import {
  fetchCodexQuotaFromApi,
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

export type CodexQuotaActionResult = ActionResult<{
  accounts: CodexAccountQuotaInfo[];
  summary: CodexQuotaSummary;
}>;

interface QuotaRequestOptions {
  forceRefresh?: boolean;
}

const CODEX_QUOTA_CACHE_PREFIX = "opendum:quota:codex";
const CODEX_QUOTA_CACHE_TTL_SECONDS = 45;

function getCodexQuotaCacheKey(userId: string): string {
  return `${CODEX_QUOTA_CACHE_PREFIX}:${userId}`;
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

export async function getCodexQuota(
  options: QuotaRequestOptions = {}
): Promise<CodexQuotaActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;
      const redis = yield* RedisService;

      const cacheKey = getCodexQuotaCacheKey(userId);

      // Cache check (fail-open)
      if (!options.forceRefresh) {
        const cached = yield* Effect.tryPromise({
          try: () => redis.get(cacheKey),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(null)));

        if (cached) {
          try {
            const parsed = JSON.parse(cached) as CodexQuotaActionResult;
            if (parsed?.success) {
              return parsed.data;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              id: providerAccount.id,
              name: providerAccount.name,
              email: providerAccount.email,
              accountId: providerAccount.accountId,
              isActive: providerAccount.isActive,
              accessToken: providerAccount.accessToken,
              refreshToken: providerAccount.refreshToken,
              expiresAt: providerAccount.expiresAt,
              lastUsedAt: providerAccount.lastUsedAt,
            })
            .from(providerAccount)
            .where(
              and(
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "codex")
              )
            )
            .orderBy(desc(providerAccount.lastUsedAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const emptyData = {
        accounts: [] as CodexAccountQuotaInfo[],
        summary: {
          totalAccounts: 0,
          activeAccounts: 0,
          byTier: {} as Record<string, number>,
          exhaustedGroups: 0,
          totalGroups: 0,
        },
      };

      if (accounts.length === 0) {
        yield* Effect.tryPromise({
          try: () =>
            redis.set(
              cacheKey,
              JSON.stringify({ success: true, data: emptyData } satisfies CodexQuotaActionResult),
              "EX",
              CODEX_QUOTA_CACHE_TTL_SECONDS
            ),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

        return emptyData;
      }

      const results: CodexAccountQuotaInfo[] = [];
      let exhaustedGroups = 0;
      let totalGroups = 0;
      const byTier: Record<string, number> = {};

      for (const account of accounts) {
        const accessToken = yield* Effect.tryPromise({
          try: () =>
            codexProvider.getValidCredentials(
              account as unknown as ProviderAccount
            ),
          catch: () => null,
        }).pipe(Effect.merge);

        if (accessToken === null) {
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

        const liveQuota = yield* Effect.promise(() =>
          fetchCodexQuotaFromApi(accessToken, account.accountId)
        );

        if (liveQuota.status === "success") {
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

      const data = {
        accounts: results,
        summary: {
          totalAccounts: results.length,
          activeAccounts: activeAccountCount,
          byTier,
          exhaustedGroups,
          totalGroups,
        },
      };

      // Cache result (fail-open)
      yield* Effect.tryPromise({
        try: () =>
          redis.set(
            cacheKey,
            JSON.stringify({ success: true, data } satisfies CodexQuotaActionResult),
            "EX",
            CODEX_QUOTA_CACHE_TTL_SECONDS
          ),
        catch: (cause) => new RedisError({ cause }),
      }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

      return data;
    }),
    MainLayer
  );
}
