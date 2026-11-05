import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import { hashString } from "@opendum/platform/crypto";
import type { Registry } from "@opendum/models/runtime";
import {
  deactivateAPIKey,
  keyByHash,
  rateLimits,
} from "@opendum/database/queries";
import {
  type Cache,
  type Cached,
  INVALID_TTL,
  VALID_TTL,
} from "@opendum/auth/cache";
import { accessList, accessMode, accountList } from "@opendum/auth/normalize";
import { type AuthResult, type RateLimitRule, emptyResult } from "@opendum/auth/types";

export type Queries = {
  keyByHash: typeof keyByHash;
  deactivateAPIKey: typeof deactivateAPIKey;
  rateLimits: typeof rateLimits;
};

const defaultQueries: Queries = {
  keyByHash,
  deactivateAPIKey,
  rateLimits,
};

export type Options = {
  registry: Registry;
  keyCache: Cache;
  queries?: Queries;
};

export class Keys {
  private readonly registry: Registry;
  private readonly keyCache: Cache;
  private readonly queries: Queries;

  constructor(options: Options) {
    this.registry = options.registry;
    this.keyCache = options.keyCache;
    this.queries = options.queries ?? defaultQueries;
  }

  validate(authHeader: string): Effect.Effect<AuthResult, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      if (!authHeader.trim()) {
        return emptyResult("Missing Authorization header");
      }
      const token = bearerToken(authHeader);
      if (!token) {
        return emptyResult("Invalid Authorization header format");
      }

      const keyHash = hashString(token);
      const cached = yield* this.keyCache.get(keyHash);
      if (cached) {
        if (!cached.valid) {
          return emptyResult(defaultString(cached.error ?? "", "Invalid API key"));
        }
        if (cached.expiresAtMs === undefined || cached.expiresAtMs > Date.now()) {
          yield* Effect.forkDetach(this.keyCache.touch(cached.apiKeyId ?? ""));
          return this.resultFromCache(cached);
        }
        yield* this.invalidate(keyHash, cached.apiKeyId ?? "");
      }

      const apiKey = yield* this.queries.keyByHash(keyHash);
      if (!apiKey) {
        yield* this.keyCache.set(
          keyHash,
          { valid: false, error: "Invalid API key" },
          INVALID_TTL
        );
        return emptyResult("Invalid API key");
      }

      if (!apiKey.isActive) {
        yield* this.keyCache.set(
          keyHash,
          { valid: false, apiKeyId: apiKey.id, error: "API key has been revoked" },
          INVALID_TTL
        );
        return emptyResult("API key has been revoked");
      }

      if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
        yield* Effect.forkDetach(this.queries.deactivateAPIKey(apiKey.id).pipe(Effect.ignore));
        yield* this.keyCache.set(
          keyHash,
          { valid: false, apiKeyId: apiKey.id, error: "API key has expired" },
          INVALID_TTL
        );
        return emptyResult("API key has expired");
      }

      const rules = yield* this.rateLimitRules(apiKey.id);
      const modelMode = accessMode(apiKey.modelAccessMode);
      const modelList = accessList(this.registry, apiKey.modelAccessList);
      const accountMode = accessMode(apiKey.accountAccessMode);
      const accounts = accountList(apiKey.accountAccessList);

      let expiresAtMs: number | undefined;
      let cacheTtl = VALID_TTL;
      if (apiKey.expiresAt) {
        expiresAtMs = apiKey.expiresAt.getTime();
        const untilExpiry = (apiKey.expiresAt.getTime() - Date.now()) / 1000;
        if (untilExpiry > 0 && untilExpiry < cacheTtl) cacheTtl = untilExpiry;
        if (cacheTtl < 1) cacheTtl = 1;
      }

      const value: Cached = {
        valid: true,
        userId: apiKey.userId,
        apiKeyId: apiKey.id,
        modelAccessMode: modelMode,
        modelAccessList: modelList,
        accountAccessMode: accountMode,
        accountAccessList: accounts,
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

  private rateLimitRules(apiKeyId: string): Effect.Effect<RateLimitRule[], DatabaseFailure> {
    return this.queries.rateLimits(apiKeyId).pipe(
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

  private resultFromCache(cached: Cached): AuthResult {
    return {
      valid: true,
      userId: cached.userId ?? "",
      apiKeyId: cached.apiKeyId ?? "",
      modelAccessMode: accessMode(cached.modelAccessMode ?? ""),
      modelAccessList: accessList(this.registry, cached.modelAccessList ?? []),
      accountAccessMode: accessMode(cached.accountAccessMode ?? ""),
      accountAccessList: accountList(cached.accountAccessList ?? []),
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
