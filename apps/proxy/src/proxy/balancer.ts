import { eq, and, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  db,
  providerAccount,
  providerAccountDisabledModel,
  providerAccountModelHealth,
  userSharingSetting,
  usageLog,
  type ProviderAccount,
} from "@opendum/database";
import type { ModelRegistry } from "@opendum/ai";
import { isRateLimited, getRateLimitScope } from "./rate-limit.js";

const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const DEGRADED_THRESHOLD = 3;
const FAILED_THRESHOLD = 7;

export interface AccountEligibilityFilter {
  userId: string;
  model: string;
  forcedAccountId?: string;
  excludeAccountIds?: string[];
  roamingEnabled?: boolean;
  accountAccessMode?: string;
  accountAccessList?: string[];
}

export class LoadBalancer {
  constructor(private registry: ModelRegistry) {}

  async getEligibleAccounts(
    filter: AccountEligibilityFilter
  ): Promise<ProviderAccount[]> {
    const canonicalModel = this.registry.resolveAlias(filter.model);
    const providers = this.registry.getProvidersForModel(canonicalModel);

    if (providers.length === 0) {
      return [];
    }

    const now = new Date();
    const query = db
      .select()
      .from(providerAccount)
      .where(
        and(
          eq(providerAccount.userId, filter.userId),
          eq(providerAccount.isActive, true),
          sql`(${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= ${now})`
        )
      );

    const rows = await query;
    const candidates = rows.filter((acc) => {
      if (!providers.includes(acc.provider)) return false;
      if (
        filter.forcedAccountId &&
        acc.id !== filter.forcedAccountId &&
        acc.provider !== filter.forcedAccountId
      ) {
        return false;
      }
      if (
        filter.excludeAccountIds &&
        filter.excludeAccountIds.includes(acc.id)
      ) {
        return false;
      }
      if (filter.accountAccessMode === "whitelist") {
        if (!filter.accountAccessList?.includes(acc.id)) return false;
      }
      if (filter.accountAccessMode === "blacklist") {
        if (filter.accountAccessList?.includes(acc.id)) return false;
      }
      return true;
    });

    const available: ProviderAccount[] = [];
    const scope = getRateLimitScope(canonicalModel);

    for (const acc of candidates) {
      const rl = await isRateLimited(acc.id, scope);
      if (rl.rateLimited) continue;

      const disabled = await db
        .select()
        .from(providerAccountDisabledModel)
        .where(
          and(
            eq(providerAccountDisabledModel.providerAccountId, acc.id),
            eq(providerAccountDisabledModel.model, canonicalModel)
          )
        )
        .limit(1);

      if (disabled.length > 0) continue;
      available.push(acc);
    }

    // If no owned accounts available and roaming enabled, fallback to shared accounts
    if (available.length === 0 && filter.roamingEnabled && !filter.forcedAccountId) {
      const sharedQuery = db
        .select({
          account: providerAccount,
        })
        .from(providerAccount)
        .innerJoin(
          userSharingSetting,
          eq(userSharingSetting.userId, providerAccount.userId)
        )
        .where(
          and(
            sql`${providerAccount.userId} != ${filter.userId}`,
            eq(userSharingSetting.enabled, true),
            eq(providerAccount.isActive, true),
            sql`(${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= ${now})`
          )
        );

      const sharedRows = await sharedQuery;
      const sharedCandidates = sharedRows
        .map((r) => r.account)
        .filter((acc) => {
          if (!providers.includes(acc.provider)) return false;
          if (filter.excludeAccountIds?.includes(acc.id)) return false;
          return true;
        });

      for (const acc of sharedCandidates) {
        const rl = await isRateLimited(acc.id, scope);
        if (rl.rateLimited) continue;

        const disabled = await db
          .select()
          .from(providerAccountDisabledModel)
          .where(
            and(
              eq(providerAccountDisabledModel.providerAccountId, acc.id),
              eq(providerAccountDisabledModel.model, canonicalModel)
            )
          )
          .limit(1);

        if (disabled.length > 0) continue;
        available.push(acc);
      }
    }

    available.sort((a, b) => {
      const aStatus = a.status === "active" ? 0 : 1;
      const bStatus = b.status === "active" ? 0 : 1;
      if (aStatus !== bStatus) return aStatus - bStatus;

      const aTime = a.lastUsedAt?.getTime() ?? 0;
      const bTime = b.lastUsedAt?.getTime() ?? 0;
      return aTime - bTime;
    });

    return available;
  }

  async markAccountSuccess(
    accountId: string,
    model: string
  ): Promise<void> {
    const canonicalModel = this.registry.resolveAlias(model);
    const now = new Date();

    await db
      .update(providerAccount)
      .set({
        lastUsedAt: now,
        lastSuccessAt: now,
        consecutiveErrors: 0,
        status: "active",
        statusChangedAt: now,
        requestCount: sql`${providerAccount.requestCount} + 1`,
        successCount: sql`${providerAccount.successCount} + 1`,
      })
      .where(eq(providerAccount.id, accountId));

    await db
      .update(providerAccountModelHealth)
      .set({
        consecutiveErrors: 0,
        status: "active",
        lastSuccessAt: now,
      })
      .where(
        and(
          eq(providerAccountModelHealth.providerAccountId, accountId),
          eq(providerAccountModelHealth.model, canonicalModel)
        )
      );
  }

  async markAccountFailed(
    accountId: string,
    model: string,
    statusCode?: number
  ): Promise<void> {
    const canonicalModel = this.registry.resolveAlias(model);
    const now = new Date();

    const [acc] = await db
      .select()
      .from(providerAccount)
      .where(eq(providerAccount.id, accountId))
      .limit(1);

    if (!acc) return;

    const errors = (acc.consecutiveErrors ?? 0) + 1;
    let newStatus = acc.status;
    let disabledUntil: Date | null = acc.disabledUntil;

    if (errors >= FAILED_THRESHOLD) {
      newStatus = "failed";
      disabledUntil = new Date(Date.now() + FAILED_COOLDOWN_MS);
    } else if (errors >= DEGRADED_THRESHOLD) {
      newStatus = "degraded";
    }

    await db
      .update(providerAccount)
      .set({
        consecutiveErrors: errors,
        errorCount: sql`${providerAccount.errorCount} + 1`,
        lastErrorAt: now,
        lastErrorCode: statusCode ?? null,
        status: newStatus,
        statusChangedAt: newStatus !== acc.status ? now : acc.statusChangedAt,
        disabledUntil,
      })
      .where(eq(providerAccount.id, accountId));

    await db
      .insert(providerAccountModelHealth)
      .values({
        id: createId(),
        providerAccountId: accountId,
        model: canonicalModel,
        consecutiveErrors: 1,
        status: "degraded",
        lastErrorAt: now,
        lastErrorCode: statusCode ?? null,
      })
      .onConflictDoUpdate({
        target: [
          providerAccountModelHealth.providerAccountId,
          providerAccountModelHealth.model,
        ],
        set: {
          consecutiveErrors: sql`${providerAccountModelHealth.consecutiveErrors} + 1`,
          lastErrorAt: now,
          lastErrorCode: statusCode ?? null,
        },
      });
  }

  async logUsage(params: {
    userId: string;
    providerAccountId?: string;
    proxyApiKeyId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    statusCode?: number;
    durationMs: number;
  }): Promise<void> {
    try {
      await db.insert(usageLog).values({
        id: createId(),
        userId: params.userId,
        providerAccountId: params.providerAccountId ?? null,
        proxyApiKeyId: params.proxyApiKeyId ?? null,
        model: this.registry.resolveAlias(params.model),
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        statusCode: params.statusCode ?? null,
        duration: params.durationMs,
        createdAt: new Date(),
      });
    } catch (e) {
      console.error("Failed to insert usage log:", e);
    }
  }
}
