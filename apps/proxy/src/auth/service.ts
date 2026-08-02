import { eq, sql } from "drizzle-orm";
import type Redis from "ioredis";
import type { ProxyDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Registry } from "../registry/index.js";
import { hashString } from "../crypto/index.js";
import {
  getCachedAPIKeyValidation,
  setCachedAPIKeyValidation,
  invalidateAPIKeyValidation,
  validTTL,
  invalidTTL,
  lastUsedTTL,
  lastUsedKey,
} from "./cache.js";
import type { AuthResult, CacheValue, RateLimitRule } from "./types.js";

export class AuthService {
  constructor(
    private db: ProxyDB | null,
    private redis: Redis | null,
    private registry: Registry,
  ) {}

  async validateAPIKey(authHeader: string): Promise<AuthResult> {
    const trimmed = authHeader.trim();
    if (trimmed === "") {
      return { valid: false, error: "Missing Authorization header" } as AuthResult;
    }

    const token = bearerToken(trimmed);
    if (token === "") {
      return { valid: false, error: "Invalid Authorization header format" } as AuthResult;
    }

    const keyHash = hashString(token);
    const cached = await getCachedAPIKeyValidation(this.redis, keyHash);
    if (cached) {
      if (!cached.valid) {
        if (cached.apiKeyId === "" || (await this.isCachedAPIKeyValidationCurrent(cached))) {
          return { valid: false, error: cached.error || "Invalid API key" } as AuthResult;
        }
        await invalidateAPIKeyValidation(this.redis, keyHash, cached.apiKeyId);
      } else if (cached.expiresAtMs === null || cached.expiresAtMs > Date.now()) {
        if (await this.isCachedAPIKeyValidationCurrent(cached)) {
          void this.touchAPIKeyLastUsed(cached.apiKeyId);
          return this.resultFromCache(cached);
        }
        await invalidateAPIKeyValidation(this.redis, keyHash, cached.apiKeyId);
      } else {
        await invalidateAPIKeyValidation(this.redis, keyHash, cached.apiKeyId);
      }
    }

    if (!this.db) {
      return { valid: false, error: "Invalid API key" } as AuthResult;
    }

    const rows = await this.db
      .select({
        id: schema.proxyApiKey.id,
        userId: schema.proxyApiKey.userId,
        isActive: schema.proxyApiKey.isActive,
        expiresAt: schema.proxyApiKey.expiresAt,
        updatedAt: schema.proxyApiKey.updatedAt,
        modelAccessMode: schema.proxyApiKey.modelAccessMode,
        modelAccessList: schema.proxyApiKey.modelAccessList,
        accountAccessMode: schema.proxyApiKey.accountAccessMode,
        accountAccessList: schema.proxyApiKey.accountAccessList,
        roamingEnabled: schema.proxyApiKey.roamingEnabled,
      })
      .from(schema.proxyApiKey)
      .where(eq(schema.proxyApiKey.keyHash, keyHash))
      .limit(1);

    if (rows.length === 0) {
      await setCachedAPIKeyValidation(this.redis, keyHash, { valid: false, error: "Invalid API key" } as CacheValue, invalidTTL);
      return { valid: false, error: "Invalid API key" } as AuthResult;
    }

    const apiKey = rows[0];
    const updatedAtMicros = Math.floor(apiKey.updatedAt.getTime() * 1000);

    if (!apiKey.isActive) {
      await setCachedAPIKeyValidation(
        this.redis,
        keyHash,
        { valid: false, apiKeyId: apiKey.id, updatedAtMicros, error: "API key has been revoked" } as CacheValue,
        invalidTTL,
      );
      return { valid: false, error: "API key has been revoked" } as AuthResult;
    }

    if (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() < Date.now()) {
      if (this.db) {
        void this.db.update(schema.proxyApiKey).set({ isActive: false }).where(eq(schema.proxyApiKey.id, apiKey.id));
      }
      await setCachedAPIKeyValidation(
        this.redis,
        keyHash,
        { valid: false, apiKeyId: apiKey.id, updatedAtMicros, error: "API key has expired" } as CacheValue,
        invalidTTL,
      );
      return { valid: false, error: "API key has expired" } as AuthResult;
    }

    const rules = await this.getRateLimitRules(apiKey.id);

    const modelMode = normalizeAccessMode(apiKey.modelAccessMode);
    const modelList = this.normalizeModelList(apiKey.modelAccessList);
    const accountMode = normalizeAccessMode(apiKey.accountAccessMode);
    const accountList = normalizeAccountList(apiKey.accountAccessList);

    let expiresAtMs: number | null = null;
    let cacheTTL = validTTL;
    if (apiKey.expiresAt !== null) {
      expiresAtMs = apiKey.expiresAt.getTime();
      const untilExpiry = apiKey.expiresAt.getTime() - Date.now();
      if (untilExpiry > 0 && untilExpiry < cacheTTL) {
        cacheTTL = untilExpiry;
      }
      if (cacheTTL < 1000) {
        cacheTTL = 1000;
      }
    }

    const cachedValue: CacheValue = {
      valid: true,
      userId: apiKey.userId,
      apiKeyId: apiKey.id,
      modelAccessMode: modelMode,
      modelAccessList: modelList,
      accountAccessMode: accountMode,
      accountAccessList: accountList,
      roamingEnabled: apiKey.roamingEnabled,
      expiresAtMs,
      updatedAtMicros,
      rateLimitRules: rules,
      error: "",
    };
    await setCachedAPIKeyValidation(this.redis, keyHash, cachedValue, cacheTTL);
    void this.touchAPIKeyLastUsed(apiKey.id);

    return this.resultFromCache(cachedValue);
  }

  async isCachedAPIKeyValidationCurrent(cached: CacheValue): Promise<boolean> {
    if (cached.apiKeyId === "" || cached.updatedAtMicros === null) return false;
    if (!this.db) return false;

    const rows = await this.db
      .select({
        id: schema.proxyApiKey.id,
        isActive: schema.proxyApiKey.isActive,
        expiresAt: schema.proxyApiKey.expiresAt,
        updatedAt: schema.proxyApiKey.updatedAt,
      })
      .from(schema.proxyApiKey)
      .where(eq(schema.proxyApiKey.id, cached.apiKeyId))
      .limit(1);

    if (rows.length === 0) return false;
    const apiKey = rows[0];
    if (Math.floor(apiKey.updatedAt.getTime() * 1000) !== cached.updatedAtMicros) return false;
    if (cached.valid && (!apiKey.isActive || (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= Date.now()))) return false;
    if (!cached.valid && apiKey.isActive && (apiKey.expiresAt === null || apiKey.expiresAt.getTime() > Date.now())) return false;
    return true;
  }

  async getRateLimitRules(apiKeyId: string): Promise<RateLimitRule[]> {
    if (!this.db) return [];
    const rows = await this.db
      .select({
        target: schema.proxyApiKeyRateLimit.target,
        targetType: schema.proxyApiKeyRateLimit.targetType,
        perMinute: schema.proxyApiKeyRateLimit.perMinute,
        perHour: schema.proxyApiKeyRateLimit.perHour,
        perDay: schema.proxyApiKeyRateLimit.perDay,
      })
      .from(schema.proxyApiKeyRateLimit)
      .where(eq(schema.proxyApiKeyRateLimit.apiKeyId, apiKeyId));

    return rows.map((row) => {
      const targetType = row.targetType !== "family" ? "model" : "family";
      return {
        target: row.target,
        targetType,
        perMinute: row.perMinute,
        perHour: row.perHour,
        perDay: row.perDay,
      };
    });
  }

  normalizeModelList(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed === "") continue;
      const model = this.registry.resolveAlias(trimmed);
      if (this.registry.isSupported(model)) {
        result.push(model);
      }
    }
    return uniqueSorted(result);
  }

  async bumpAnalyticsCacheVersion(userId: string): Promise<void> {
    const { bumpAnalyticsCacheVersionThrottled } = await import("./cache.js");
    await bumpAnalyticsCacheVersionThrottled(this.redis, userId);
  }

  resultFromCache(cached: CacheValue): AuthResult {
    return {
      valid: true,
      userId: cached.userId,
      apiKeyId: cached.apiKeyId,
      modelAccessMode: normalizeAccessMode(cached.modelAccessMode),
      modelAccessList: this.normalizeModelList(cached.modelAccessList),
      accountAccessMode: normalizeAccessMode(cached.accountAccessMode),
      accountAccessList: normalizeAccountList(cached.accountAccessList),
      roamingEnabled: cached.roamingEnabled,
      rateLimitRules: cached.rateLimitRules,
      error: "",
    };
  }

  async touchAPIKeyLastUsed(apiKeyId: string): Promise<void> {
    if (apiKeyId === "") return;
    if (!this.redis || !this.db) return;
    try {
      const key = lastUsedKey(apiKeyId);
      const updated = await this.redis.set(key, "1", "PX", lastUsedTTL, "NX");
      if (updated !== "OK") return;
      await this.db.execute(sql`UPDATE proxy_api_key SET "lastUsedAt" = NOW() WHERE id = ${apiKeyId}`);
    } catch {
      // ignore
    }
  }
}

export function bearerToken(authHeader: string): string {
  const trimmed = authHeader.trim();
  if (trimmed.length >= 7 && trimmed.slice(0, 7).toLowerCase() === "bearer ") {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

export function normalizeAccessMode(mode: string): string {
  if (mode === "whitelist" || mode === "blacklist") return mode;
  return "all";
}

export function normalizeAccountList(values: string[]): string[] {
  return uniqueSorted(values.map((v) => v.trim()).filter(Boolean));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
