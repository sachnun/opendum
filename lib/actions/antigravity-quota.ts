"use server";

/**
 * Server Actions for Antigravity Quota Monitoring
 */

import { Effect } from "effect";
import { DatabaseService, RedisService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, RedisError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";
import type { ProviderAccount } from "@/lib/db/schema";
import { providerAccount } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { decrypt } from "@/lib/encryption";
import {
  fetchQuotaFromApi,
  type QuotaGroupInfo,
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

export type QuotaActionResult = ActionResult<{
  accounts: AccountQuotaInfo[];
  summary: QuotaSummary;
}>;

interface QuotaRequestOptions {
  forceRefresh?: boolean;
}

const ANTIGRAVITY_QUOTA_CACHE_PREFIX = "opendum:quota:antigravity";
const ANTIGRAVITY_QUOTA_CACHE_TTL_SECONDS = 45;

function getAntigravityQuotaCacheKey(userId: string): string {
  return `${ANTIGRAVITY_QUOTA_CACHE_PREFIX}:${userId}`;
}

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
export async function getAntigravityQuota(
  options: QuotaRequestOptions = {}
): Promise<QuotaActionResult> {
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;
      const redis = yield* RedisService;

      const cacheKey = getAntigravityQuotaCacheKey(userId);

      // Cache check (fail-open)
      if (!options.forceRefresh) {
        const cached = yield* Effect.tryPromise({
          try: () => redis.get(cacheKey),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(null)));

        if (cached) {
          try {
            const parsed = JSON.parse(cached) as QuotaActionResult;
            if (parsed?.success) {
              return parsed.data;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }

      // Get all Antigravity accounts for this user
      const accounts = yield* Effect.tryPromise({
        try: () =>
          db
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
                eq(providerAccount.userId, userId),
                eq(providerAccount.provider, "antigravity")
              )
            )
            .orderBy(desc(providerAccount.lastUsedAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const emptyData = {
        accounts: [] as AccountQuotaInfo[],
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
              JSON.stringify({ success: true, data: emptyData } satisfies QuotaActionResult),
              "EX",
              ANTIGRAVITY_QUOTA_CACHE_TTL_SECONDS
            ),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

        return emptyData;
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
        let accessToken: string | null = null;
        const isActuallyExpired = account.expiresAt && new Date(account.expiresAt) < new Date();

        if (isActuallyExpired) {
          // Token expired - try to refresh
          accessToken = yield* Effect.tryPromise({
            try: () =>
              antigravityProvider.getValidCredentials(
                account as unknown as ProviderAccount
              ),
            catch: () => null,
          }).pipe(Effect.merge);

          if (accessToken === null) {
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
        const quotaResult = yield* Effect.promise(() =>
          fetchQuotaFromApi(
            accessToken!,
            account.projectId ?? "",
            tier
          )
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
            JSON.stringify({ success: true, data } satisfies QuotaActionResult),
            "EX",
            ANTIGRAVITY_QUOTA_CACHE_TTL_SECONDS
          ),
        catch: (cause) => new RedisError({ cause }),
      }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

      return data;
    }),
    MainLayer
  );
}
