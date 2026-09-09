import { eq, sql } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RedisClientType } from "redis";
import {
    db,
    proxyApiKey,
    proxyApiKeyRateLimit,
    disabledModel,
    providerAccount,
    providerAccountDisabledModel,
    userSharingSetting,
    hashString,
} from "@opendum/database";
import type { ModelRegistry } from "@opendum/ai";
import { config } from "../config.js";
import type { ApiKeyRateLimitRule } from "../proxy/key-limit.js";

export interface ValidateApiKeyResult {
    valid: boolean;
    error?: string;
    userId?: string;
    apiKeyId?: string;
    modelAccessMode?: string;
    modelAccessList?: string[];
    accountAccessMode?: string;
    accountAccessList?: string[];
    roamingEnabled?: boolean;
    rateLimitRules?: ApiKeyRateLimitRule[];
    expiresAtMs?: number | null;
    updatedAtMs?: number;
}

export interface ModelAccess {
    mode?: string;
    models?: string[];
    modelAccessMode?: string;
    modelAccessList?: string[];
}

export interface ModelValidationResult {
    valid: boolean;
    model?: string;
    forcedAccountId?: string;
    error?: string;
    code?: string;
}

export interface AccountModelAvailability {
    ownedAccountsByProvider: Map<string, string[]>;
    sharedAccountsByProvider: Map<string, string[]>;
    ownedDisabledModelsByAccount: Map<string, Set<string>>;
    sharedDisabledModelsByAccount: Map<string, Set<string>>;
}

export class AuthService {
    constructor(
        private redis: RedisClientType | null,
        private registry: ModelRegistry,
    ) {}

    validatePlaygroundAuth(
        userIdHeader?: string,
        timestampHeader?: string,
        signatureHeader?: string,
        method?: string,
        path?: string,
    ): ValidateApiKeyResult | null {
        if (!userIdHeader && !timestampHeader && !signatureHeader) {
            return null;
        }
        if (!userIdHeader || !timestampHeader || !signatureHeader) {
            return {
                valid: false,
                error: "Incomplete playground authentication",
            };
        }

        const secret = config.betterAuthSecret;
        if (!secret)
            return { valid: false, error: "Playground auth not configured" };

        const ts = parseInt(timestampHeader, 10);
        if (isNaN(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 120) {
            return { valid: false, error: "Playground session expired" };
        }

        const expected = createHmac("sha256", secret)
            .update(
                `${userIdHeader}\n${timestampHeader}\n${method || "POST"}\n${path || ""}`,
            )
            .digest("hex");

        const signature = Buffer.from(signatureHeader, "hex");
        const expectedSignature = Buffer.from(expected, "hex");
        if (
            signatureHeader.length !== expected.length ||
            !/^[0-9a-f]+$/i.test(signatureHeader) ||
            signature.length !== expectedSignature.length ||
            !timingSafeEqual(signature, expectedSignature)
        ) {
            return { valid: false, error: "Invalid playground signature" };
        }

        return {
            valid: true,
            userId: userIdHeader,
            modelAccessMode: "all",
            accountAccessMode: "all",
            roamingEnabled: false,
        };
    }

    async validateAPIKey(authHeader: string): Promise<ValidateApiKeyResult> {
        const rawKey = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (!rawKey) {
            return { valid: false, error: "Missing API key." };
        }

        const keyHash = hashString(rawKey);
        const cacheKey = `opendum:api-key:validation:${keyHash}`;

        if (this.redis) {
            try {
                const rawCached = await this.redis.get(cacheKey);
                if (rawCached) {
                    const cached = JSON.parse(
                        rawCached,
                    ) as ValidateApiKeyResult;
                    if (!cached.valid) return cached;
                    if (
                        Object.prototype.hasOwnProperty.call(
                            cached,
                            "expiresAtMs",
                        ) &&
                        typeof cached.updatedAtMs === "number" &&
                        (cached.expiresAtMs === null ||
                            (typeof cached.expiresAtMs === "number" &&
                                cached.expiresAtMs > Date.now()))
                    ) {
                        const [freshness] = await db
                            .select({
                                isActive: proxyApiKey.isActive,
                                expiresAt: proxyApiKey.expiresAt,
                                updatedAt: proxyApiKey.updatedAt,
                            })
                            .from(proxyApiKey)
                            .where(eq(proxyApiKey.keyHash, keyHash))
                            .limit(1);
                        if (
                            freshness?.isActive &&
                            (!freshness.expiresAt ||
                                freshness.expiresAt.getTime() > Date.now()) &&
                            freshness.updatedAt.getTime() === cached.updatedAtMs
                        ) {
                            return cached;
                        }
                    }
                    await this.redis.del(cacheKey);
                }
            } catch {
                // Redis fallback
            }
        }

        const rows = await db
            .select()
            .from(proxyApiKey)
            .where(eq(proxyApiKey.keyHash, keyHash))
            .limit(1);

        if (rows.length === 0) {
            const result = { valid: false, error: "Invalid API key." };
            await this.cacheAPIKeyValidation(cacheKey, result, 10_000);
            return result;
        }

        const record = rows[0]!;
        if (!record.isActive) {
            const result = { valid: false, error: "API key is disabled." };
            await this.cacheAPIKeyValidation(cacheKey, result, 10_000);
            return result;
        }

        if (record.expiresAt && Date.now() >= record.expiresAt.getTime()) {
            void db
                .update(proxyApiKey)
                .set({ isActive: false })
                .where(eq(proxyApiKey.id, record.id))
                .catch(() => undefined);
            const result = { valid: false, error: "API key is expired." };
            await this.cacheAPIKeyValidation(cacheKey, result, 10_000);
            return result;
        }

        const rateLimitRows = await db
            .select({
                target: proxyApiKeyRateLimit.target,
                targetType: proxyApiKeyRateLimit.targetType,
                perMinute: proxyApiKeyRateLimit.perMinute,
                perHour: proxyApiKeyRateLimit.perHour,
                perDay: proxyApiKeyRateLimit.perDay,
            })
            .from(proxyApiKeyRateLimit)
            .where(eq(proxyApiKeyRateLimit.apiKeyId, record.id));

        const rateLimitRules: ApiKeyRateLimitRule[] = rateLimitRows.map(
            (r) => ({
                target: r.target,
                targetType: r.targetType === "family" ? "family" : "model",
                perMinute: r.perMinute,
                perHour: r.perHour,
                perDay: r.perDay,
            }),
        );

        const result: ValidateApiKeyResult = {
            valid: true,
            userId: record.userId,
            apiKeyId: record.id,
            modelAccessMode: record.modelAccessMode,
            modelAccessList: record.modelAccessList ?? [],
            accountAccessMode: record.accountAccessMode,
            accountAccessList: record.accountAccessList ?? [],
            roamingEnabled: record.roamingEnabled,
            rateLimitRules,
            expiresAtMs: record.expiresAt?.getTime() ?? null,
            updatedAtMs: record.updatedAt.getTime(),
        };

        const ttlMs = Math.max(
            1,
            Math.min(45_000, (result.expiresAtMs ?? Infinity) - Date.now()),
        );
        await this.cacheAPIKeyValidation(cacheKey, result, ttlMs);
        void db
            .update(proxyApiKey)
            .set({ lastUsedAt: new Date() })
            .where(eq(proxyApiKey.id, record.id))
            .catch(() => undefined);

        return result;
    }

    private async cacheAPIKeyValidation(
        cacheKey: string,
        result: ValidateApiKeyResult,
        ttlMs: number,
    ): Promise<void> {
        if (!this.redis) return;
        try {
            await this.redis.set(cacheKey, JSON.stringify(result), {
                PX: ttlMs,
            });
        } catch {
            // Redis fallback
        }
    }

    async validateModelForUser(
        userId: string,
        modelParam: string,
        access: ModelAccess,
    ): Promise<ModelValidationResult> {
        const trimmed = modelParam.trim();
        let rawModel = trimmed;
        let forcedAccountId: string | undefined;

        const wholeModel = this.registry.resolveAlias(trimmed);
        if (this.registry.getProvidersForModel(wholeModel).length === 0) {
            const separator = trimmed.indexOf("/");
            if (separator > 0 && separator < trimmed.length - 1) {
                forcedAccountId = trimmed.slice(0, separator);
                rawModel = trimmed.slice(separator + 1);
            }
        }

        const model = this.registry.resolveAlias(rawModel);
        const providers = this.registry.getProvidersForModel(model);
        if (providers.length === 0) {
            return {
                valid: false,
                model,
                forcedAccountId,
                error: `Invalid model: ${modelParam}. Use GET /v1/models for the full list.`,
                code: "invalid_model",
            };
        }

        if (forcedAccountId) {
            const knownProviders = new Set(
                this.registry
                    .getAllCanonicalModels()
                    .flatMap((candidate) =>
                        this.registry.getProvidersForModel(candidate),
                    ),
            );
            let forcedProvider = knownProviders.has(forcedAccountId)
                ? forcedAccountId
                : undefined;
            if (!forcedProvider) {
                const [forcedAccount] = await db
                    .select({ provider: providerAccount.provider })
                    .from(providerAccount)
                    .where(eq(providerAccount.id, forcedAccountId))
                    .limit(1);
                forcedProvider = forcedAccount?.provider;
            }
            if (forcedProvider && !providers.includes(forcedProvider)) {
                return {
                    valid: false,
                    model,
                    forcedAccountId,
                    error: `Model "${model}" is not supported by provider "${forcedProvider}". Supported providers: ${providers.join(", ")}`,
                    code: "invalid_provider_model",
                };
            }
        }

        const accessMode = access.mode ?? access.modelAccessMode;
        const accessModels = new Set(
            (access.models ?? access.modelAccessList ?? []).map((candidate) =>
                this.registry.resolveAlias(candidate.trim()),
            ),
        );
        if (
            (accessMode === "whitelist" && !accessModels.has(model)) ||
            (accessMode === "blacklist" && accessModels.has(model))
        ) {
            return {
                valid: false,
                model,
                forcedAccountId,
                error: `Invalid model: ${modelParam}. Use GET /v1/models for the full list.`,
                code: "invalid_model",
            };
        }

        const disabledModels = await this.disabledModelSetForUser(userId);
        if (disabledModels.has(model)) {
            return {
                valid: false,
                model,
                forcedAccountId,
                error: `Model "${model}" is disabled. Enable it from Dashboard > Models first.`,
                code: "model_disabled",
            };
        }

        return { valid: true, model, forcedAccountId };
    }

    async disabledModelSetForUser(userId: string): Promise<Set<string>> {
        const rows = await db
            .select({ model: disabledModel.model })
            .from(disabledModel)
            .where(eq(disabledModel.userId, userId));

        return new Set(rows.map((r) => this.registry.resolveAlias(r.model)));
    }

    async getAccountModelAvailabilityWithSharing(
        userId: string,
        roamingEnabled: boolean,
    ): Promise<AccountModelAvailability> {
        const availability: AccountModelAvailability = {
            ownedAccountsByProvider: new Map(),
            sharedAccountsByProvider: new Map(),
            ownedDisabledModelsByAccount: new Map(),
            sharedDisabledModelsByAccount: new Map(),
        };

        const owned = await db
            .select()
            .from(providerAccount)
            .where(
                sql`${providerAccount.userId} = ${userId} AND ${providerAccount.isActive} = true AND (${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= ${new Date()})`,
            );

        for (const acc of owned) {
            const list =
                availability.ownedAccountsByProvider.get(acc.provider) || [];
            list.push(acc.id);
            availability.ownedAccountsByProvider.set(acc.provider, list);
        }

        if (roamingEnabled) {
            const shared = await db
                .select({
                    account: providerAccount,
                })
                .from(providerAccount)
                .innerJoin(
                    userSharingSetting,
                    eq(userSharingSetting.userId, providerAccount.userId),
                )
                .where(
                    sql`${providerAccount.userId} != ${userId} AND ${providerAccount.isActive} = true AND ${userSharingSetting.enabled} = true AND (${providerAccount.disabledUntil} IS NULL OR ${providerAccount.disabledUntil} <= ${new Date()})`,
                );

            for (const row of shared) {
                const acc = row.account;
                const list =
                    availability.sharedAccountsByProvider.get(acc.provider) ||
                    [];
                list.push(acc.id);
                availability.sharedAccountsByProvider.set(acc.provider, list);
            }
        }

        const allAccountIds = [
            ...owned.map((a) => a.id),
            ...Array.from(
                availability.sharedAccountsByProvider.values(),
            ).flat(),
        ];

        if (allAccountIds.length > 0) {
            const ownedAccountIds = new Set(owned.map((account) => account.id));
            const disabledModels = await db
                .select()
                .from(providerAccountDisabledModel)
                .where(
                    sql`${providerAccountDisabledModel.providerAccountId} IN ${allAccountIds}`,
                );

            for (const d of disabledModels) {
                const canonical = this.registry.resolveAlias(d.model);
                if (ownedAccountIds.has(d.providerAccountId)) {
                    let s = availability.ownedDisabledModelsByAccount.get(
                        d.providerAccountId,
                    );
                    if (!s) {
                        s = new Set();
                        availability.ownedDisabledModelsByAccount.set(
                            d.providerAccountId,
                            s,
                        );
                    }
                    s.add(canonical);
                } else {
                    let s = availability.sharedDisabledModelsByAccount.get(
                        d.providerAccountId,
                    );
                    if (!s) {
                        s = new Set();
                        availability.sharedDisabledModelsByAccount.set(
                            d.providerAccountId,
                            s,
                        );
                    }
                    s.add(canonical);
                }
            }
        }

        return availability;
    }

    isModelUsableByAccounts(
        model: string,
        availability: AccountModelAvailability,
    ): boolean {
        const canonical = this.registry.resolveAlias(model);
        const providers = this.registry.getProvidersForModel(canonical);

        for (const p of providers) {
            if (this.registry.isAuthlessProviderModel(canonical, p))
                return true;
            const accounts = availability.ownedAccountsByProvider.get(p);
            if (
                accounts?.some(
                    (accountId) =>
                        !availability.ownedDisabledModelsByAccount
                            .get(accountId)
                            ?.has(canonical),
                )
            ) {
                return true;
            }
        }
        return false;
    }

    isModelUsableBySharedAccounts(
        model: string,
        availability: AccountModelAvailability,
    ): boolean {
        const canonical = this.registry.resolveAlias(model);
        const providers = this.registry.getProvidersForModel(canonical);

        for (const p of providers) {
            const accounts = availability.sharedAccountsByProvider.get(p);
            if (
                accounts?.some(
                    (accountId) =>
                        !availability.sharedDisabledModelsByAccount
                            .get(accountId)
                            ?.has(canonical),
                )
            ) {
                return true;
            }
        }
        return false;
    }
}
