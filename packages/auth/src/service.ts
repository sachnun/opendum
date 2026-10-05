import { hashString } from "@opendum/crypto";
import type { CacheValue } from "#auth/cache.ts";
import * as authCache from "#auth/cache.ts";
import { apiKeyLastUsedKey, apiKeyValidationKey } from "@opendum/redis";
import { deactivateAPIKey, getAPIKeyByHash } from "@opendum/database/queries";
import {
  type AuthResult,
  type ModelAccess,
  type ModelValidationResult,
  emptyAuthResult,
} from "#auth/types.ts";
import {
  bearerToken,
  defaultString,
  disabled,
  invalid,
  normalizeAccessMode,
  normalizeAccountList,
  parseModelParam,
  valid,
} from "#auth/helpers.ts";
import { AuthServiceBase } from "#auth/service-base.ts";

export { isAuthlessProvider, isAuthlessProviderAccountId, parseModelParam } from "#auth/helpers.ts";

const VALID_TTL_SECONDS = 45;
const INVALID_TTL_SECONDS = 10;

export class AuthService extends AuthServiceBase {
  async validateAPIKey(authHeader: string): Promise<AuthResult> {
    if (!authHeader.trim()) {
      return emptyAuthResult("Missing Authorization header");
    }
    const token = bearerToken(authHeader);
    if (!token) {
      return emptyAuthResult("Invalid Authorization header format");
    }

    const keyHash = hashString(token);
    const cached = await this.getCachedAPIKeyValidation(keyHash);
    if (cached) {
      if (!cached.valid) {
        return emptyAuthResult(defaultString(cached.error ?? "", "Invalid API key"));
      }
      if (cached.expiresAtMs === undefined || cached.expiresAtMs > Date.now()) {
        void this.touchAPIKeyLastUsed(cached.apiKeyId ?? "");
        return this.resultFromCache(cached);
      }
      await this.invalidateAPIKeyValidation(keyHash, cached.apiKeyId ?? "");
    }

    const apiKey = await getAPIKeyByHash(keyHash);
    if (!apiKey) {
      await this.setCachedAPIKeyValidation(
        keyHash,
        { valid: false, error: "Invalid API key" },
        INVALID_TTL_SECONDS
      );
      return emptyAuthResult("Invalid API key");
    }

    if (!apiKey.isActive) {
      await this.setCachedAPIKeyValidation(
        keyHash,
        { valid: false, apiKeyId: apiKey.id, error: "API key has been revoked" },
        INVALID_TTL_SECONDS
      );
      return emptyAuthResult("API key has been revoked");
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() < Date.now()) {
      void deactivateAPIKey(apiKey.id);
      await this.setCachedAPIKeyValidation(
        keyHash,
        { valid: false, apiKeyId: apiKey.id, error: "API key has expired" },
        INVALID_TTL_SECONDS
      );
      return emptyAuthResult("API key has expired");
    }

    const rules = await this.getRateLimitRules(apiKey.id);
    const modelMode = normalizeAccessMode(apiKey.modelAccessMode);
    const modelList = this.normalizeModelAccessList(apiKey.modelAccessList);
    const accountMode = normalizeAccessMode(apiKey.accountAccessMode);
    const accountList = normalizeAccountList(apiKey.accountAccessList);

    let expiresAtMs: number | undefined;
    let cacheTtl = VALID_TTL_SECONDS;
    if (apiKey.expiresAt) {
      expiresAtMs = apiKey.expiresAt.getTime();
      const untilExpiry = (apiKey.expiresAt.getTime() - Date.now()) / 1000;
      if (untilExpiry > 0 && untilExpiry < cacheTtl) cacheTtl = untilExpiry;
      if (cacheTtl < 1) cacheTtl = 1;
    }

    const value: CacheValue = {
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
    await this.setCachedAPIKeyValidation(keyHash, value, cacheTtl);
    void this.touchAPIKeyLastUsed(apiKey.id);
    return this.resultFromCache(value);
  }

  async invalidateAPIKeyValidation(keyHash: string, apiKeyId: string): Promise<void> {
    const keys = [apiKeyValidationKey(keyHash)];
    if (apiKeyId) keys.push(apiKeyLastUsedKey(apiKeyId));
    try {
      await this.redis.del(keys);
    } catch {
      return;
    }
  }

  validateModel(modelParam: string): ModelValidationResult {
    const [provider, rawModel] = parseModelParam(modelParam);
    const model = this.registry.resolveAlias(rawModel);
    if (provider === "codex" && !this.isCodexChatGPTModel(model)) {
      const supported = this.codexChatGPTModels().join(", ");
      return invalid(
        provider,
        model,
        `Model "${rawModel}" is not supported for Codex when using a ChatGPT account. Use one of: ${supported}.`,
        "model",
        "unsupported_codex_chatgpt_model"
      );
    }
    if (!this.registry.isSupported(model)) {
      return this.invalidModelResult(provider, rawModel, modelParam, null);
    }
    if (provider && !this.registry.isSupportedByProvider(model, provider)) {
      const supported = this.registry.providersForModel(model).join(", ");
      return invalid(
        provider,
        model,
        `Model "${model}" is not supported by provider "${provider}". Supported providers: ${supported}`,
        "model",
        "invalid_provider_model"
      );
    }
    return valid(provider, model);
  }

  async validateModelForUser(
    userId: string,
    modelParam: string,
    access: ModelAccess
  ): Promise<ModelValidationResult> {
    const [provider, rawModel] = parseModelParam(modelParam);
    const mode = normalizeAccessMode(access.mode);
    const modelSet = new Set<string>();
    for (const model of this.normalizeModelList(access.models)) modelSet.add(model);
    for (const model of access.models) {
      const trimmed = model.trim();
      if (trimmed) modelSet.add(trimmed);
    }

    if (provider && this.customProviders) {
      const custom = await this.customModelResult(userId, provider, rawModel);
      if (custom) {
        if (!custom.valid) return custom;
        if (mode === "whitelist" || mode === "blacklist") {
          let listed = modelSet.has(custom.model);
          if (!listed && custom.alias) listed = modelSet.has(custom.alias);
          if (mode === "whitelist" && !listed) {
            return this.invalidModelResult(custom.provider, custom.model, modelParam, null);
          }
          if (mode === "blacklist" && listed) {
            return this.invalidModelResult(custom.provider, custom.model, modelParam, null);
          }
        }
        const modelToCheck = custom.alias || custom.model;
        if (await this.isModelDisabledForUser(userId, modelToCheck)) {
          return disabled(custom.provider, custom.model);
        }
        return custom;
      }
    }

    const base = this.validateModel(modelParam);
    if (!base.valid && base.code !== "invalid_model") return base;

    let isInvalid = !base.valid;
    if (!isInvalid && mode === "whitelist") isInvalid = !this.isModelListed(modelSet, base.model, provider);
    if (!isInvalid && mode === "blacklist") isInvalid = this.isModelListed(modelSet, base.model, provider);
    if (!isInvalid) {
      if (await this.isModelDisabledForUser(userId, base.model)) {
        return disabled(base.provider, base.model);
      }
      return base;
    }

    const candidates = await this.usableModelCandidates(userId, provider, mode, modelSet, access.roamingEnabled);
    const suggestProvider = base.valid ? base.provider : provider;
    const suggestModel = base.valid ? base.model : rawModel;
    return this.invalidModelResult(suggestProvider, suggestModel, modelParam, candidates);
  }

  async listUserCustomModels(userId: string): Promise<Array<Record<string, unknown>>> {
    const { standalone } = await this.customProviderModelSets(userId);
    const now = Math.floor(Date.now() / 1000);
    const items: Array<Record<string, unknown>> = [];
    for (const [slug, models] of standalone) {
      for (const modelId of models) {
        items.push({
          id: `${slug}/${modelId}`,
          object: "model",
          created: now,
          owned_by: `custom:${slug}`,
        });
      }
    }
    return items;
  }

  async bumpAnalyticsCacheVersionThrottled(userId: string): Promise<void> {
    await authCache.bumpAnalyticsCacheVersionThrottled(this.redis, userId);
  }
}
