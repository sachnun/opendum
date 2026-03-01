"use server";

import { Effect } from "effect";
import { DatabaseService, RedisService, requireUserId } from "@/lib/effect/services";
import { DatabaseError, RedisError } from "@/lib/effect/errors";
import { runServerAction, MainLayer, type ActionResult } from "@/lib/effect/runtime";
import type { ProviderAccount } from "@/lib/db/schema";
import { providerAccount } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import {
  geminiCliProvider,
  fetchGeminiCliAccountInfo,
} from "@/lib/proxy/providers/gemini-cli/client";
import {
  fetchGeminiCliQuotaFromApi,
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

export type GeminiCliQuotaActionResult = ActionResult<{
  accounts: GeminiCliAccountQuotaInfo[];
  summary: GeminiCliQuotaSummary;
}>;

interface QuotaRequestOptions {
  forceRefresh?: boolean;
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
  return runServerAction(
    Effect.gen(function* () {
      const userId = yield* requireUserId;
      const db = yield* DatabaseService;
      const redis = yield* RedisService;

      const cacheKey = getGeminiCliQuotaCacheKey(userId);

      // Cache check (fail-open)
      if (!options.forceRefresh) {
        const cached = yield* Effect.tryPromise({
          try: () => redis.get(cacheKey),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(null)));

        if (cached) {
          try {
            const parsed = JSON.parse(cached) as GeminiCliQuotaActionResult;
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
                eq(providerAccount.provider, "gemini_cli")
              )
            )
            .orderBy(desc(providerAccount.lastUsedAt)),
        catch: (cause) => new DatabaseError({ cause }),
      });

      const emptyData = {
        accounts: [] as GeminiCliAccountQuotaInfo[],
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
              JSON.stringify({ success: true, data: emptyData } satisfies GeminiCliQuotaActionResult),
              "EX",
              GEMINI_CLI_QUOTA_CACHE_TTL_SECONDS
            ),
          catch: (cause) => new RedisError({ cause }),
        }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

        return emptyData;
      }

      const results: GeminiCliAccountQuotaInfo[] = [];
      let exhaustedGroups = 0;
      let totalGroups = 0;
      const byTier: Record<string, number> = {};

      for (const account of accounts) {
        const accessToken = yield* Effect.tryPromise({
          try: () =>
            geminiCliProvider.getValidCredentials(
              account as unknown as ProviderAccount
            ),
          catch: () => null,
        }).pipe(Effect.merge);

        if (accessToken === null) {
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

        // Re-fetch metadata in case it was updated by a concurrent refresh
        const [refreshedMeta] = yield* Effect.tryPromise({
          try: () =>
            db
              .select({
                projectId: providerAccount.projectId,
                tier: providerAccount.tier,
              })
              .from(providerAccount)
              .where(eq(providerAccount.id, account.id))
              .limit(1),
          catch: (cause) => new DatabaseError({ cause }),
        });

        let projectId = refreshedMeta?.projectId ?? account.projectId;
        let tier = refreshedMeta?.tier ?? account.tier ?? "free-tier";
        let projectDiscoveryError: string | undefined;

        // Attempt project discovery if missing
        if (!projectId) {
          const accountInfo = yield* Effect.tryPromise({
            try: () => fetchGeminiCliAccountInfo(accessToken),
            catch: () => ({ projectId: null, tier: null, email: null, error: "Failed to discover project" }),
          }).pipe(Effect.merge);

          if ("error" in accountInfo && typeof accountInfo.error === "string") {
            projectDiscoveryError = accountInfo.error;
          }

          if (accountInfo.projectId) {
            projectId = accountInfo.projectId;
            tier = accountInfo.tier || tier;
            projectDiscoveryError = undefined;

            yield* Effect.tryPromise({
              try: () =>
                db
                  .update(providerAccount)
                  .set({
                    projectId: accountInfo.projectId,
                    tier,
                    email: accountInfo.email || account.email,
                  })
                  .where(eq(providerAccount.id, account.id)),
              catch: (cause) => new DatabaseError({ cause }),
            });
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

        const liveQuota = yield* Effect.promise(() =>
          fetchGeminiCliQuotaFromApi(accessToken, projectId!, tier)
        );

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
            JSON.stringify({ success: true, data } satisfies GeminiCliQuotaActionResult),
            "EX",
            GEMINI_CLI_QUOTA_CACHE_TTL_SECONDS
          ),
        catch: (cause) => new RedisError({ cause }),
      }).pipe(Effect.catchTag("RedisError", () => Effect.succeed(void 0)));

      return data;
    }),
    MainLayer
  );
}
