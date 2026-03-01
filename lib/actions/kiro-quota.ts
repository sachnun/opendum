"use server";

import { Effect } from "effect";
import { DatabaseService, RedisService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, RedisError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";
import type { ProviderAccount } from "@/lib/db/schema";
import { providerAccount } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
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

export type KiroQuotaActionResult = ActionResult<{
  accounts: KiroAccountQuotaInfo[];
  summary: KiroQuotaSummary;
}>;

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
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;
      const redis = yield* RedisService;

      const cacheKey = getKiroQuotaCacheKey(userId);

      // Cache check (fail-open)
      if (!options.forceRefresh) {
        const cached = yield* Effect.tryPromise({
          try: () => redis.get(cacheKey),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(null)));

        if (cached) {
          try {
            const parsed = JSON.parse(cached) as KiroQuotaActionResult;
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
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "kiro")
              )
            )
            .orderBy(desc(providerAccount.lastUsedAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const emptyData = {
        accounts: [] as KiroAccountQuotaInfo[],
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
              JSON.stringify({ success: true, data: emptyData } satisfies KiroQuotaActionResult),
              "EX",
              KIRO_QUOTA_CACHE_TTL_SECONDS
            ),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

        return emptyData;
      }

      const results: KiroAccountQuotaInfo[] = [];
      let exhaustedGroups = 0;
      let totalGroups = 0;
      const byTier: Record<string, number> = {};

      for (const account of accounts) {
        const accessToken = yield* Effect.tryPromise({
          try: () =>
            kiroProvider.getValidCredentials(
              account as unknown as ProviderAccount
            ),
          catch: () => null,
        }).pipe(Effect.merge);

        if (accessToken === null) {
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

        const liveQuota = yield* Effect.promise(() =>
          fetchKiroQuotaFromApi(accessToken, account.accountId)
        );
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
            JSON.stringify({ success: true, data } satisfies KiroQuotaActionResult),
            "EX",
            KIRO_QUOTA_CACHE_TTL_SECONDS
          ),
        catch: (cause) => new RedisError({ cause }),
      }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

      return data;
    }),
    MainLayer
  );
}
