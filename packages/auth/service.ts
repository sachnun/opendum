import { Effect } from "effect";
import type { DatabaseFailure } from "@opendum/database";
import { ignore } from "@opendum/core/best-effort";
import type { Registry } from "@opendum/models/runtime";
import {
  versionBump,
  versionKey,
  type OpendumRedis,
} from "@opendum/core/redis";
import { Policy } from "@opendum/auth/policy";
import { Cache } from "@opendum/auth/cache";
import { Keys } from "@opendum/auth/keys";
import { Availability } from "@opendum/auth/availability";
import { CustomModels } from "@opendum/auth/custom-models";
import { disabled } from "@opendum/auth/results";
import {
  listed,
  accessMode,
  modelList,
  parseModel,
} from "@opendum/auth/normalize";
import { type CustomProviderReader, customStore } from "@opendum/auth/store/custom";
import {
  type AccountModelAvailability,
  type AuthResult,
  type ModelAccess,
  type ModelValidationResult,
} from "@opendum/auth/types";

const VERSION_TTL = 30 * 24 * 60 * 60;
const BUMP_TTL = 15;

export class AuthService {
  private readonly registry: Registry;
  private readonly redis: OpendumRedis;
  private readonly customProviders: CustomProviderReader;
  private readonly accessPolicy: Policy;
  private readonly apiKeys: Keys;
  private readonly customModels: CustomModels;
  private readonly avail: Availability;

  constructor(
    registry: Registry,
    redis: OpendumRedis,
    customProviders: CustomProviderReader = customStore()
  ) {
    this.registry = registry;
    this.redis = redis;
    this.customProviders = customProviders;
    this.accessPolicy = new Policy(registry);
    this.apiKeys = new Keys({ registry, keyCache: new Cache(redis) });
    this.customModels = new CustomModels(registry, customProviders);
    this.avail = new Availability({
      registry,
      redis,
      customModels: this.customModels,
      accessPolicy: this.accessPolicy,
    });
  }

  validateKey(authHeader: string): Effect.Effect<AuthResult, DatabaseFailure> {
    return this.apiKeys.validate(authHeader);
  }

  invalidateKey(keyHash: string, apiKeyId: string): Effect.Effect<void> {
    return this.apiKeys.invalidate(keyHash, apiKeyId);
  }

  disabledModels(userId: string): Effect.Effect<Set<string>, DatabaseFailure> {
    return this.avail.disabledModels(userId);
  }

  isDisabled(userId: string, model: string): Effect.Effect<boolean, DatabaseFailure> {
    return this.avail.isDisabled(userId, model);
  }

  availability(
    userId: string,
    includeShared: boolean,
    options: { includeInactiveAccounts?: boolean } = {}
  ): Effect.Effect<AccountModelAvailability, DatabaseFailure> {
    return this.avail.availability(userId, includeShared, options);
  }

  usable(model: string, availability: AccountModelAvailability): boolean {
    return this.accessPolicy.usable(model, availability);
  }

  usableShared(
    model: string,
    availability: AccountModelAvailability
  ): boolean {
    return this.accessPolicy.usableShared(model, availability);
  }

  validateModel(modelParam: string): ModelValidationResult {
    return this.accessPolicy.validateModel(modelParam);
  }

  validateFor(
    userId: string,
    modelParam: string,
    access: ModelAccess
  ): Effect.Effect<ModelValidationResult, DatabaseFailure> {
    return Effect.gen({ self: this }, function* () {
      const [provider, rawModel] = parseModel(modelParam);
      const mode = accessMode(access.mode);
      const modelSet = new Set<string>();
      for (const model of modelList(this.registry, access.models)) modelSet.add(model);
      for (const model of access.models) {
        const trimmed = model.trim();
        if (trimmed) modelSet.add(trimmed);
      }

      if (provider && this.customProviders) {
        const custom = yield* this.customModels.result(userId, provider, rawModel);
        if (custom) {
          if (!custom.valid) return custom;
          if (mode === "whitelist" || mode === "blacklist") {
            let listed = modelSet.has(custom.model);
            if (!listed && custom.alias) listed = modelSet.has(custom.alias);
            if (mode === "whitelist" && !listed) {
              return this.accessPolicy.invalidResult(custom.provider, custom.model, modelParam, null);
            }
            if (mode === "blacklist" && listed) {
              return this.accessPolicy.invalidResult(custom.provider, custom.model, modelParam, null);
            }
          }
          const modelToCheck = custom.alias || custom.model;
          if (yield* this.avail.isDisabled(userId, modelToCheck)) {
            return disabled(custom.provider, custom.model);
          }
          return custom;
        }
      }

      const base = this.accessPolicy.validateModel(modelParam);
      if (!base.valid && base.code !== "invalid_model") return base;

      let isInvalid = !base.valid;
      if (!isInvalid && mode === "whitelist") isInvalid = !listed(modelSet, base.model, provider);
      if (!isInvalid && mode === "blacklist") isInvalid = listed(modelSet, base.model, provider);
      if (!isInvalid) {
        if (yield* this.avail.isDisabled(userId, base.model)) {
          return disabled(base.provider, base.model);
        }
        return base;
      }

      const candidates = yield* this.avail.candidates(
        userId,
        provider,
        mode,
        modelSet,
        access.roamingEnabled
      );
      const suggestProvider = base.valid ? base.provider : provider;
      const suggestModel = base.valid ? base.model : rawModel;
      return this.accessPolicy.invalidResult(suggestProvider, suggestModel, modelParam, candidates);
    });
  }

  list(userId: string): Effect.Effect<Array<Record<string, unknown>>, DatabaseFailure> {
    return this.customModels.list(userId);
  }

  bumpVersion(userId: string): Effect.Effect<void> {
    if (!userId) return Effect.void;
    return ignore(async () => {
      const updated = await this.redis.set(versionBump(userId), "1", {
        NX: true,
        EX: BUMP_TTL,
      });
      if (!updated) return;
      const version = await this.redis.incr(versionKey(userId));
      if (version === 1) {
        await this.redis.expire(versionKey(userId), VERSION_TTL);
      }
    });
  }
}

export { isAuthless, authlessAccount } from "@opendum/auth/authless";
