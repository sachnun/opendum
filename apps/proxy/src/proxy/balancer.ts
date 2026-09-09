import { eq, and, inArray, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
    db,
    providerAccount,
    providerAccountDisabledModel,
    providerAccountModelHealth,
    userSharingSetting,
    usageLog,
    type ProviderAccount,
    type ProviderAccountModelHealth,
} from "@opendum/database";
import type { ModelRegistry } from "@opendum/ai";
import { isRateLimited, getRateLimitScope } from "./rate-limit.js";

const FAILED_COOLDOWN_MS = 10 * 60 * 1000;
const UNHEALTHY_IDLE_DECAY_MS = 10 * 60 * 1000;
const MODEL_DEGRADED_THRESHOLD = 2;
const ACCOUNT_COOLDOWN_THRESHOLD = 10;
const COOLDOWN_RECOVERY_RATIO = 0.3;

const PAID_TIERS = new Set([
    "paid",
    "standard-tier",
    "plus",
    "pro",
    "pro-plus",
    "pro+",
    "prolite",
    "power",
    "team",
    "go",
    "self_serve_business_usage_based",
    "business",
    "enterprise_cbp_usage_based",
    "enterprise",
    "edu",
    "education",
    "hc",
]);

interface AvailableAccount {
    account: ProviderAccount;
    modelDegraded: boolean;
    sortStatus: string;
}

function latestHealthRequestAt(row: ProviderAccountModelHealth): Date {
    return [
        row.unhealthyCountUpdatedAt,
        row.lastErrorAt,
        row.lastSuccessAt,
        row.updatedAt,
        row.createdAt,
    ].reduce<Date>(
        (latest, value) =>
            value && value.getTime() > latest.getTime() ? value : latest,
        row.createdAt,
    );
}

function effectiveUnhealthyCount(
    row: ProviderAccountModelHealth,
    now: Date,
): number {
    const count = Math.max(0, row.consecutiveErrors);
    const latest = latestHealthRequestAt(row);
    if (count === 0 || latest.getTime() > now.getTime()) return count;

    const decay = Math.floor(
        (now.getTime() - latest.getTime()) / UNHEALTHY_IDLE_DECAY_MS,
    );
    return Math.max(0, count - decay);
}

function modelHealthStatus(unhealthyCount: number): string {
    return unhealthyCount >= MODEL_DEGRADED_THRESHOLD ? "degraded" : "active";
}

function cooldownRecoveryCount(unhealthyCount: number): number {
    return Math.max(
        0,
        unhealthyCount - Math.round(unhealthyCount * COOLDOWN_RECOVERY_RATIO),
    );
}

function isImmediatelyRecoverableStatusCode(code: number): boolean {
    return code === 408 || code === 429 || code >= 500;
}

function isPaidAccountTier(account: ProviderAccount): boolean {
    const tier = account.tier?.trim().toLowerCase();
    if (!tier) return false;
    if (account.provider === "antigravity") {
        return tier === "paid" || tier === "standard-tier";
    }
    if (account.provider === "kiro") {
        return ["pro", "pro+", "pro-plus", "power"].includes(tier);
    }
    return PAID_TIERS.has(tier);
}

function normalizeTier(tier: string | null | undefined): string {
    const normalized = (tier ?? "").trim().toLowerCase().replaceAll("_", "-");
    if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
    if (normalized === "free-tier") return "free";
    if (
        ["education", "educational", "edu", "free-educational-quota"].includes(
            normalized,
        )
    ) {
        return "student";
    }
    return normalized;
}

function tierSatisfiesRule(
    tier: string | null | undefined,
    minTier?: string,
    allowedTiers?: string[],
): boolean {
    const normalizedTier = normalizeTier(tier);
    if (allowedTiers?.length) {
        return allowedTiers.some(
            (allowed) => normalizeTier(allowed) === normalizedTier,
        );
    }
    const required = normalizeTier(minTier);
    return !required || required === "free" || normalizedTier === required;
}

function compareNullableDates(a: Date | null, b: Date | null): number {
    if (a === null && b === null) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a.getTime() - b.getTime();
}

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
        filter: AccountEligibilityFilter,
    ): Promise<ProviderAccount[]> {
        const canonicalModel = this.registry.resolveAlias(filter.model);
        const providers = this.registry.getProvidersForModel(canonicalModel);
        if (providers.length === 0) return [];

        const now = new Date();
        const forcedSelector = filter.forcedAccountId?.trim();
        const knownProviders = new Set(
            this.registry
                .getAllCanonicalModels()
                .flatMap((model) => this.registry.getProvidersForModel(model)),
        );
        const forcedProvider =
            forcedSelector && knownProviders.has(forcedSelector)
                ? forcedSelector
                : undefined;
        if (forcedProvider && !providers.includes(forcedProvider)) return [];
        const targetProviders = forcedProvider ? [forcedProvider] : providers;

        const rows = await db
            .select()
            .from(providerAccount)
            .where(
                and(
                    eq(providerAccount.userId, filter.userId),
                    eq(providerAccount.isActive, true),
                    sql`(${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= ${now})`,
                ),
            );

        const candidates = rows.filter((account) => {
            if (!targetProviders.includes(account.provider)) return false;
            const accessRule = this.registry.getProviderAccessRule(
                canonicalModel,
                account.provider,
            );
            if (
                accessRule &&
                !tierSatisfiesRule(
                    account.tier,
                    accessRule.minTier,
                    accessRule.allowedTiers,
                )
            ) {
                return false;
            }
            if (
                forcedSelector &&
                !forcedProvider &&
                account.id !== forcedSelector
            ) {
                return false;
            }
            if (filter.excludeAccountIds?.includes(account.id)) return false;
            if (
                filter.accountAccessMode === "whitelist" &&
                !filter.accountAccessList?.includes(account.id)
            ) {
                return false;
            }
            if (
                filter.accountAccessMode === "blacklist" &&
                filter.accountAccessList?.includes(account.id)
            ) {
                return false;
            }
            return true;
        });

        if (!forcedSelector) {
            for (const provider of targetProviders) {
                if (
                    !this.registry.isAuthlessProviderModel(
                        canonicalModel,
                        provider,
                    )
                ) {
                    continue;
                }
                candidates.push({
                    id: `authless:${provider}`,
                    userId: filter.userId,
                    provider,
                    name: provider,
                    accessToken: "",
                    refreshToken: "",
                    expiresAt: new Date(8640000000000000),
                    apiKey: null,
                    projectId: null,
                    tier: null,
                    accountId: null,
                    email: null,
                    isActive: true,
                    disabledUntil: null,
                    lastUsedAt: null,
                    requestCount: 0,
                    errorCount: 0,
                    consecutiveErrors: 0,
                    lastErrorAt: null,
                    lastErrorCode: null,
                    lastRecoveredByRotationAt: null,
                    status: "active",
                    statusChangedAt: null,
                    successCount: 0,
                    lastSuccessAt: null,
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                });
            }
        }

        const scope = getRateLimitScope(canonicalModel);
        let available = await this.filterAvailableAccounts(
            candidates,
            canonicalModel,
            scope,
            now,
        );

        if (filter.roamingEnabled && !forcedSelector) {
            const sharedRows = await db
                .select({ account: providerAccount })
                .from(providerAccount)
                .innerJoin(
                    userSharingSetting,
                    eq(userSharingSetting.userId, providerAccount.userId),
                )
                .where(
                    and(
                        sql`${providerAccount.userId} != ${filter.userId}`,
                        eq(userSharingSetting.enabled, true),
                        eq(providerAccount.isActive, true),
                        sql`(${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= ${now})`,
                    ),
                );

            const sharedCandidates = sharedRows
                .map((row) => row.account)
                .filter((account) => {
                    if (!providers.includes(account.provider)) return false;
                    if (filter.excludeAccountIds?.includes(account.id))
                        return false;
                    if (
                        filter.accountAccessMode === "whitelist" &&
                        !filter.accountAccessList?.includes(account.id)
                    ) {
                        return false;
                    }
                    if (
                        filter.accountAccessMode === "blacklist" &&
                        filter.accountAccessList?.includes(account.id)
                    ) {
                        return false;
                    }
                    const accessRule = this.registry.getProviderAccessRule(
                        canonicalModel,
                        account.provider,
                    );
                    return (
                        !accessRule ||
                        tierSatisfiesRule(
                            account.tier,
                            accessRule.minTier,
                            accessRule.allowedTiers,
                        )
                    );
                });
            available.push(
                ...(await this.filterAvailableAccounts(
                    sharedCandidates,
                    canonicalModel,
                    scope,
                    now,
                )),
            );
        }

        const providerOrder = new Map(
            providers.map((provider, index) => [provider, index]),
        );
        available.sort((a, b) => {
            const ownershipDifference =
                Number(b.account.userId === filter.userId) -
                Number(a.account.userId === filter.userId);
            if (ownershipDifference !== 0) return ownershipDifference;

            if (a.modelDegraded !== b.modelDegraded) {
                return a.modelDegraded ? 1 : -1;
            }

            const providerDifference =
                (providerOrder.get(a.account.provider) ??
                    Number.MAX_SAFE_INTEGER) -
                (providerOrder.get(b.account.provider) ??
                    Number.MAX_SAFE_INTEGER);
            if (providerDifference !== 0) return providerDifference;

            const paidDifference =
                Number(isPaidAccountTier(b.account)) -
                Number(isPaidAccountTier(a.account));
            if (paidDifference !== 0) return paidDifference;

            if (a.sortStatus !== b.sortStatus) {
                return a.sortStatus < b.sortStatus ? -1 : 1;
            }

            const lastUsedDifference = compareNullableDates(
                a.account.lastUsedAt,
                b.account.lastUsedAt,
            );
            if (lastUsedDifference !== 0) return lastUsedDifference;
            return (
                a.account.createdAt.getTime() - b.account.createdAt.getTime()
            );
        });

        return available.map(({ account }) => account);
    }

    private modelLookupKeys(model: string): Set<string> {
        const canonical = this.registry.resolveAlias(model);
        const keys = new Set([canonical, model]);
        const info = this.registry.getModel(canonical);
        for (const alias of info?.aliases ?? []) keys.add(alias);
        for (const config of Object.values(info?.providerConfig ?? {})) {
            if (config.upstream) keys.add(config.upstream);
            for (const alias of config.aliases ?? []) keys.add(alias);
        }
        return keys;
    }

    private modelKeyMatches(
        storedModel: string,
        canonicalModel: string,
        lookupKeys: Set<string>,
    ): boolean {
        return (
            lookupKeys.has(storedModel) ||
            this.registry.resolveAlias(storedModel) === canonicalModel
        );
    }

    private async filterAvailableAccounts(
        candidates: ProviderAccount[],
        canonicalModel: string,
        scope: string,
        now: Date,
    ): Promise<AvailableAccount[]> {
        if (candidates.length === 0) return [];

        const accountIds = candidates.map((account) => account.id);
        const [disabledRows, healthRows] = await Promise.all([
            db
                .select()
                .from(providerAccountDisabledModel)
                .where(
                    inArray(
                        providerAccountDisabledModel.providerAccountId,
                        accountIds,
                    ),
                ),
            db
                .select()
                .from(providerAccountModelHealth)
                .where(
                    inArray(
                        providerAccountModelHealth.providerAccountId,
                        accountIds,
                    ),
                ),
        ]);
        const lookupKeys = this.modelLookupKeys(canonicalModel);
        const disabledAccountIds = new Set(
            disabledRows
                .filter((row) =>
                    this.modelKeyMatches(row.model, canonicalModel, lookupKeys),
                )
                .map((row) => row.providerAccountId),
        );
        const healthByAccount = new Map<string, ProviderAccountModelHealth[]>();
        for (const row of healthRows) {
            const rows = healthByAccount.get(row.providerAccountId) ?? [];
            rows.push(row);
            healthByAccount.set(row.providerAccountId, rows);
        }

        const available: AvailableAccount[] = [];
        for (const account of candidates) {
            const rateLimit = await isRateLimited(account.id, scope);
            if (rateLimit.rateLimited || disabledAccountIds.has(account.id))
                continue;

            const refreshed = await this.refreshAccountHealth(
                account,
                healthByAccount.get(account.id) ?? [],
                now,
            );
            if (refreshed.coolingDown) continue;

            const modelDegraded = refreshed.healthRows.some(
                (row) =>
                    this.modelKeyMatches(
                        row.model,
                        canonicalModel,
                        lookupKeys,
                    ) && row.status === "degraded",
            );
            available.push({
                account: refreshed.account,
                modelDegraded,
                sortStatus: account.status,
            });
        }
        return available;
    }

    private async refreshAccountHealth(
        account: ProviderAccount,
        healthRows: ProviderAccountModelHealth[],
        now: Date,
    ): Promise<{
        account: ProviderAccount;
        healthRows: ProviderAccountModelHealth[];
        coolingDown: boolean;
    }> {
        const applyCooldownRecovery =
            account.status === "failed" &&
            account.disabledUntil !== null &&
            account.disabledUntil.getTime() <= now.getTime();
        const normalizedRows: ProviderAccountModelHealth[] = [];
        let totalUnhealthy = 0;

        for (const row of healthRows) {
            let unhealthyCount = effectiveUnhealthyCount(row, now);
            if (applyCooldownRecovery) {
                unhealthyCount = cooldownRecoveryCount(unhealthyCount);
            }
            const status = modelHealthStatus(unhealthyCount);
            const statusChanged = status !== row.status;
            const countChanged = unhealthyCount !== row.consecutiveErrors;

            if (countChanged || statusChanged || applyCooldownRecovery) {
                await db
                    .update(providerAccountModelHealth)
                    .set({
                        consecutiveErrors: unhealthyCount,
                        status,
                        statusChangedAt: statusChanged
                            ? now
                            : row.statusChangedAt,
                        unhealthyCountUpdatedAt: now,
                    })
                    .where(eq(providerAccountModelHealth.id, row.id));
            }

            normalizedRows.push({
                ...row,
                consecutiveErrors: unhealthyCount,
                status,
                statusChangedAt: statusChanged ? now : row.statusChangedAt,
                unhealthyCountUpdatedAt:
                    countChanged || statusChanged || applyCooldownRecovery
                        ? now
                        : row.unhealthyCountUpdatedAt,
            });
            totalUnhealthy += unhealthyCount;
        }

        if (
            account.disabledUntil !== null &&
            account.disabledUntil.getTime() > now.getTime()
        ) {
            if (
                account.status !== "failed" ||
                account.consecutiveErrors !== totalUnhealthy
            ) {
                await db
                    .update(providerAccount)
                    .set({
                        status: "failed",
                        statusChangedAt: now,
                        consecutiveErrors: totalUnhealthy,
                    })
                    .where(eq(providerAccount.id, account.id));
            }
            return {
                account: {
                    ...account,
                    status: "failed",
                    statusChangedAt: now,
                    consecutiveErrors: totalUnhealthy,
                },
                healthRows: normalizedRows,
                coolingDown: true,
            };
        }

        if (totalUnhealthy >= ACCOUNT_COOLDOWN_THRESHOLD) {
            const disabledUntil = new Date(now.getTime() + FAILED_COOLDOWN_MS);
            await db
                .update(providerAccount)
                .set({
                    status: "failed",
                    statusChangedAt: now,
                    consecutiveErrors: totalUnhealthy,
                    disabledUntil,
                })
                .where(eq(providerAccount.id, account.id));
            return {
                account: {
                    ...account,
                    status: "failed",
                    statusChangedAt: now,
                    consecutiveErrors: totalUnhealthy,
                    disabledUntil,
                },
                healthRows: normalizedRows,
                coolingDown: true,
            };
        }

        const accountChanged =
            account.status !== "active" ||
            account.disabledUntil !== null ||
            account.consecutiveErrors !== totalUnhealthy;
        if (accountChanged) {
            await db
                .update(providerAccount)
                .set({
                    status: "active",
                    statusChangedAt: now,
                    consecutiveErrors: totalUnhealthy,
                    disabledUntil: null,
                })
                .where(eq(providerAccount.id, account.id));
        }
        return {
            account: accountChanged
                ? {
                      ...account,
                      status: "active",
                      statusChangedAt: now,
                      consecutiveErrors: totalUnhealthy,
                      disabledUntil: null,
                  }
                : account,
            healthRows: normalizedRows,
            coolingDown: false,
        };
    }

    async markAccountSuccess(accountId: string, model: string): Promise<void> {
        const canonicalModel = this.registry.resolveAlias(model);
        const now = new Date();
        const [account] = await db
            .select()
            .from(providerAccount)
            .where(eq(providerAccount.id, accountId))
            .limit(1);
        if (!account) return;

        await db
            .update(providerAccount)
            .set({
                lastUsedAt: now,
                lastSuccessAt: now,
                requestCount: sql`${providerAccount.requestCount} + 1`,
                successCount: sql`${providerAccount.successCount} + 1`,
            })
            .where(eq(providerAccount.id, accountId));

        const [health] = await db
            .select()
            .from(providerAccountModelHealth)
            .where(
                and(
                    eq(providerAccountModelHealth.providerAccountId, accountId),
                    eq(providerAccountModelHealth.model, canonicalModel),
                ),
            )
            .limit(1);

        if (health) {
            let unhealthyCount = effectiveUnhealthyCount(health, now);
            if (
                unhealthyCount > 0 &&
                (health.lastErrorCode === null ||
                    isImmediatelyRecoverableStatusCode(health.lastErrorCode))
            ) {
                unhealthyCount--;
            }
            const status = modelHealthStatus(unhealthyCount);
            await db
                .update(providerAccountModelHealth)
                .set({
                    consecutiveErrors: unhealthyCount,
                    status,
                    statusChangedAt:
                        status !== health.status ? now : health.statusChangedAt,
                    lastSuccessAt: now,
                    unhealthyCountUpdatedAt: now,
                })
                .where(eq(providerAccountModelHealth.id, health.id));
        }

        const healthRows = await db
            .select()
            .from(providerAccountModelHealth)
            .where(eq(providerAccountModelHealth.providerAccountId, accountId));
        await this.refreshAccountHealth(
            { ...account, lastUsedAt: now, lastSuccessAt: now },
            healthRows,
            now,
        );
    }

    async markAccountFailed(
        accountId: string,
        model: string,
        statusCode?: number,
    ): Promise<void> {
        const canonicalModel = this.registry.resolveAlias(model);
        const now = new Date();
        const [account] = await db
            .select()
            .from(providerAccount)
            .where(eq(providerAccount.id, accountId))
            .limit(1);
        if (!account) return;

        await db
            .update(providerAccount)
            .set({
                errorCount: sql`${providerAccount.errorCount} + 1`,
                lastErrorAt: now,
                lastErrorCode: statusCode ?? null,
            })
            .where(eq(providerAccount.id, accountId));

        const [health] = await db
            .select()
            .from(providerAccountModelHealth)
            .where(
                and(
                    eq(providerAccountModelHealth.providerAccountId, accountId),
                    eq(providerAccountModelHealth.model, canonicalModel),
                ),
            )
            .limit(1);

        if (health) {
            const unhealthyCount = effectiveUnhealthyCount(health, now) + 1;
            const status = modelHealthStatus(unhealthyCount);
            await db
                .update(providerAccountModelHealth)
                .set({
                    consecutiveErrors: unhealthyCount,
                    status,
                    statusChangedAt:
                        status !== health.status ? now : health.statusChangedAt,
                    lastErrorAt: now,
                    lastErrorCode: statusCode ?? null,
                    unhealthyCountUpdatedAt: now,
                })
                .where(eq(providerAccountModelHealth.id, health.id));
        } else {
            await db
                .insert(providerAccountModelHealth)
                .values({
                    id: createId(),
                    providerAccountId: accountId,
                    model: canonicalModel,
                    consecutiveErrors: 1,
                    status: modelHealthStatus(1),
                    lastErrorAt: now,
                    lastErrorCode: statusCode ?? null,
                    unhealthyCountUpdatedAt: now,
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
                        unhealthyCountUpdatedAt: now,
                    },
                });
        }

        const healthRows = await db
            .select()
            .from(providerAccountModelHealth)
            .where(eq(providerAccountModelHealth.providerAccountId, accountId));
        await this.refreshAccountHealth(account, healthRows, now);
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
                providerAccountId: params.providerAccountId?.startsWith(
                    "authless:",
                )
                    ? null
                    : (params.providerAccountId ?? null),
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
