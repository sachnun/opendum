import { Effect } from "effect";
import { ignoringErrors } from "@opendum/core/best-effort";
import type { Registry } from "@opendum/models/runtime";
import {
  analyticsVersionBumpKey,
  analyticsVersionKey,
  type OpendumRedis,
} from "@opendum/core/redis";
import { AccessPolicy } from "./access-policy.js";
import { APIKeyCache } from "./api-key-cache.js";
import { APIKeyValidator } from "./api-key-validator.js";
import { AvailabilityService } from "./availability-service.js";
import { CustomModelService } from "./custom-model-service.js";
import { disabled } from "./model-results.js";
import {
  isModelListed,
  normalizeAccessMode,
  normalizeModelList,
  parseModelParam,
} from "./normalize.js";
import { type CustomProviderReader, createCustomStore } from "./store/custom.js";
import {
  type AccountModelAvailability,
  type AuthResult,
  type ModelAccess,
  type ModelValidationResult,
} from "./types.js";

const ANALYTICS_VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ANALYTICS_BUMP_TTL_SECONDS = 15;

export class AuthService {
  private readonly registry: Registry;
  private readonly redis: OpendumRedis;
  private readonly customProviders: CustomProviderReader;
  private readonly accessPolicy: AccessPolicy;
  private readonly apiKeys: APIKeyValidator;
  private readonly customModels: CustomModelService;
  private readonly availability: AvailabilityService;

  constructor(
    registry: Registry,
    redis: OpendumRedis,
    customProviders: CustomProviderReader = createCustomStore()
  ) {
    this.registry = registry;
    this.redis = redis;
    this.customProviders = customProviders;
    this.accessPolicy = new AccessPolicy(registry);
    this.apiKeys = new APIKeyValidator({ registry, keyCache: new APIKeyCache(redis) });
    this.customModels = new CustomModelService(registry, customProviders);
    this.availability = new AvailabilityService({
      registry,
      redis,
      customModels: this.customModels,
      accessPolicy: this.accessPolicy,
    });
  }

  validateAPIKey(authHeader: string): Effect.Effect<AuthResult> {
    return this.apiKeys.validate(authHeader);
  }

  invalidateAPIKeyValidation(keyHash: string, apiKeyId: string): Effect.Effect<void> {
    return this.apiKeys.invalidate(keyHash, apiKeyId);
  }

  disabledModelSetForUser(userId: string): Effect.Effect<Set<string>> {
    return this.availability.disabledModelSetForUser(userId);
  }

  isModelDisabledForUser(userId: string, model: string): Effect.Effect<boolean> {
    return this.availability.isModelDisabledForUser(userId, model);
  }

  getAccountModelAvailabilityWithSharing(
    userId: string,
    includeShared: boolean,
    options: { includeInactiveAccounts?: boolean } = {}
  ): Effect.Effect<AccountModelAvailability> {
    return this.availability.getAccountModelAvailabilityWithSharing(userId, includeShared, options);
  }

  isModelUsableByAccounts(model: string, availability: AccountModelAvailability): boolean {
    return this.accessPolicy.isModelUsableByAccounts(model, availability);
  }

  isModelUsableBySharedAccounts(
    model: string,
    availability: AccountModelAvailability
  ): boolean {
    return this.accessPolicy.isModelUsableBySharedAccounts(model, availability);
  }

  validateModel(modelParam: string): ModelValidationResult {
    return this.accessPolicy.validateModel(modelParam);
  }

  validateModelForUser(
    userId: string,
    modelParam: string,
    access: ModelAccess
  ): Effect.Effect<ModelValidationResult> {
    return Effect.gen({ self: this }, function* () {
      const [provider, rawModel] = parseModelParam(modelParam);
      const mode = normalizeAccessMode(access.mode);
      const modelSet = new Set<string>();
      for (const model of normalizeModelList(this.registry, access.models)) modelSet.add(model);
      for (const model of access.models) {
        const trimmed = model.trim();
        if (trimmed) modelSet.add(trimmed);
      }

      if (provider && this.customProviders) {
        const custom = yield* this.customModels.customModelResult(userId, provider, rawModel);
        if (custom) {
          if (!custom.valid) return custom;
          if (mode === "whitelist" || mode === "blacklist") {
            let listed = modelSet.has(custom.model);
            if (!listed && custom.alias) listed = modelSet.has(custom.alias);
            if (mode === "whitelist" && !listed) {
              return this.accessPolicy.invalidModelResult(custom.provider, custom.model, modelParam, null);
            }
            if (mode === "blacklist" && listed) {
              return this.accessPolicy.invalidModelResult(custom.provider, custom.model, modelParam, null);
            }
          }
          const modelToCheck = custom.alias || custom.model;
          if (yield* this.availability.isModelDisabledForUser(userId, modelToCheck)) {
            return disabled(custom.provider, custom.model);
          }
          return custom;
        }
      }

      const base = this.accessPolicy.validateModel(modelParam);
      if (!base.valid && base.code !== "invalid_model") return base;

      let isInvalid = !base.valid;
      if (!isInvalid && mode === "whitelist") isInvalid = !isModelListed(modelSet, base.model, provider);
      if (!isInvalid && mode === "blacklist") isInvalid = isModelListed(modelSet, base.model, provider);
      if (!isInvalid) {
        if (yield* this.availability.isModelDisabledForUser(userId, base.model)) {
          return disabled(base.provider, base.model);
        }
        return base;
      }

      const candidates = yield* this.availability.usableModelCandidates(
        userId,
        provider,
        mode,
        modelSet,
        access.roamingEnabled
      );
      const suggestProvider = base.valid ? base.provider : provider;
      const suggestModel = base.valid ? base.model : rawModel;
      return this.accessPolicy.invalidModelResult(suggestProvider, suggestModel, modelParam, candidates);
    });
  }

  listUserCustomModels(userId: string): Effect.Effect<Array<Record<string, unknown>>> {
    return this.customModels.listUserCustomModels(userId);
  }

  bumpAnalyticsCacheVersionThrottled(userId: string): Effect.Effect<void> {
    if (!userId) return Effect.void;
    return ignoringErrors(async () => {
      const updated = await this.redis.set(analyticsVersionBumpKey(userId), "1", {
        NX: true,
        EX: ANALYTICS_BUMP_TTL_SECONDS,
      });
      if (!updated) return;
      const version = await this.redis.incr(analyticsVersionKey(userId));
      if (version === 1) {
        await this.redis.expire(analyticsVersionKey(userId), ANALYTICS_VERSION_TTL_SECONDS);
      }
    });
  }
}

export { isAuthlessProvider, isAuthlessProviderAccountId } from "./authless.js";
