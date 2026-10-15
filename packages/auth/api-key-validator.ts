import { Effect } from "effect";
import { hashString } from "@opendum/core/crypto";
import type { Registry } from "@opendum/models/runtime";
import {
  deactivateAPIKey,
  getAPIKeyByHash,
  listAPIKeyRateLimits,
} from "@opendum/database/queries";
import {
  type APIKeyCache,
  type CachedAPIKeyValidation,
  INVALID_CACHE_TTL_SECONDS,
  VALID_CACHE_TTL_SECONDS,
} from "./api-key-cache.js";
import { normalizeAccessList, normalizeAccessMode, normalizeAccountList } from "./normalize.js";
import { type AuthResult, type RateLimitRule, emptyAuthResult } from "./types.js";

export type APIKeyQueries = {
  getAPIKeyByHash: typeof getAPIKeyByHash;
  deactivateAPIKey: typeof deactivateAPIKey;
  listAPIKeyRateLimits: typeof listAPIKeyRateLimits;
};

const defaultQueries: APIKeyQueries = {
  getAPIKeyByHash,
  deactivateAPIKey,
  listAPIKeyRateLimits,
};

export type APIKeyValidatorOptions = {
  registry: Registry;
  keyCache: APIKeyCache;
  queries?: APIKeyQueries;
};

export class APIKeyValidator {
  private readonly registry: Registry;
  private readonly keyCache: APIKeyCache;
  private readonly queries: APIKeyQueries;

  constructor(options: APIKeyValidatorOptions) {
    this.registry = options.registry;
    this.keyCache = options.keyCache;
    this.queries = options.queries ?? defaultQueries;
  }

  validate(authHeader: string): Effect.Effect<AuthResult> {
    return Effect.gen({ self: this }, function* () {
      if (!authHeader.trim()) {
        return emptyAuthResult("Missing Authorization header");
      }
      const token = bearerToken(authHeader);
      if (!token) {
        return emptyAuthResult("Invalid Authorization header format");
      }

      const keyHash = hashString(token);
      const cached = yield* this.keyCache.get(keyHash);
      if (cached) {
        if (!cached.valid) {
          return emptyAuthResult(defaultString(cached.error ?? "", "Invalid API key"));
        }
        if (cached.expiresAtMs === undefined || cached.expiresAtMs > Date.now()) {
          yield* Effect.forkDetach(this.keyCache.touch(cached.apiKeyId ?? ""));
          return this.resultFromCache(cached);
        }
        yield* this.invalidate(keyHash, cached.apiKeyId ?? "");
      }

      const apiKey = yield* Effect.promise(() => this.queries.getAPIKeyByHash(keyHash));
      if (!apiKey) {
        yield* this.keyCache.set(
          keyHash,
          { valid: false, error: "Invalid API key" },
          INVALID_CACHE_TTL_SECONDS
        );
        return emptyAuthResult("Invalid API key");
      }

      if (!apiKey.isActive) {
        yield* this.keyCache.set(
          keyHash,
          { valid: false, apiKeyId: apiKey.id, error: "API key has been revoked" },
          INVALID_CACHE_TTL_SECONDS
        );
        return emptyAuthResult("API key has been revoked");
      }

      if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
        yield* Effect.forkDetach(Effect.promise(() => this.queries.deactivateAPIKey(apiKey.id)));
        yield* this.keyCache.set(
          keyHash,
          { valid: false, apiKeyId: apiKey.id, error: "API key has expired" },
          INVALID_CACHE_TTL_SECONDS
        );
        return emptyAuthResult("API key has expired");
      }

      const rules = yield* this.rateLimitRules(apiKey.id);
      const modelMode = normalizeAccessMode(apiKey.modelAccessMode);
      const modelList = normalizeAccessList(this.registry, apiKey.modelAccessList);
      const accountMode = normalizeAccessMode(apiKey.accountAccessMode);
      const accountList = normalizeAccountList(apiKey.accountAccessList);

      let expiresAtMs: number | undefined;
      let cacheTtl = VALID_CACHE_TTL_SECONDS;
      if (apiKey.expiresAt) {
        expiresAtMs = apiKey.expiresAt.getTime();
        const untilExpiry = (apiKey.expiresAt.getTime() - Date.now()) / 1000;
        if (untilExpiry > 0 && untilExpiry < cacheTtl) cacheTtl = untilExpiry;
        if (cacheTtl < 1) cacheTtl = 1;
      }

      const value: CachedAPIKeyValidation = {
        valid: true,
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        modelAccessMode: modelMode,
        modelAccessList: modelList,
        accountAccessMode: accountMode,
        accountAccessList: accountList,
        roamingEnabled: apiKey.roamingEnabled,
        expiresAtMs,
        rateLimitRules: rules,
      };
      yield* this.keyCache.set(keyHash, value, cacheTtl);
      yield* Effect.forkDetach(this.keyCache.touch(apiKey.id));
      return this.resultFromCache(value);
    });
  }

  invalidate(keyHash: string, apiKeyId: string): Effect.Effect<void> {
    return this.keyCache.invalidate(keyHash, apiKeyId);
  }

  private rateLimitRules(apiKeyId: string): Effect.Effect<RateLimitRule[]> {
    return Effect.promise(() => this.queries.listAPIKeyRateLimits(apiKeyId)).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          target: row.target,
          targetType: row.targetType === "family" ? "family" : "model",
          perMinute: row.perMinute,
          perHour: row.perHour,
          perDay: row.perDay,
        }))
      )
    );
  }

  private resultFromCache(cached: CachedAPIKeyValidation): AuthResult {
    return {
      valid: true,
      userId: cached.userId ?? "",
      apiKeyId: cached.apiKeyId ?? "",
      modelAccessMode: normalizeAccessMode(cached.modelAccessMode ?? ""),
      modelAccessList: normalizeAccessList(this.registry, cached.modelAccessList ?? []),
      accountAccessMode: normalizeAccessMode(cached.accountAccessMode ?? ""),
      accountAccessList: normalizeAccountList(cached.accountAccessList ?? []),
      roamingEnabled: Boolean(cached.roamingEnabled),
      rateLimitRules: cached.rateLimitRules ?? [],
      error: "",
    };
  }
}

function bearerToken(authHeader: string): string {
  const trimmed = authHeader.trim();
  if (trimmed.length >= 7 && trimmed.slice(0, 7).toLowerCase() === "bearer ") {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function defaultString(value: string, fallback: string): string {
  return value || fallback;
}
