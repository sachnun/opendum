import { hashString } from "@opendum/crypto";
import type { CacheValue } from "#auth/cache.ts";
import * as authCache from "#auth/cache.ts";
import type { Registry } from "@opendum/models/runtime";
import { apiKeyLastUsedKey, apiKeyValidationKey, type OpendumRedis } from "@opendum/redis";
import { deactivateAPIKey, getAPIKeyByHash, listDisabledModelsByUser } from "@opendum/database/queries";
import { type CustomProviderReader, createCustomStore } from "#auth/custom-store.ts";
import {
  type AccountModelAvailability,
  type AuthResult,
  type ModelAccess,
  type ModelValidationResult,
  type RateLimitRule,
  emptyAuthResult,
} from "#auth/types.ts";
import {
  computeAccountModelAvailability,
  isModelUsableByAccounts as isModelUsableByAccountsImpl,
  isModelUsableBySharedAccounts as isModelUsableBySharedAccountsImpl,
} from "#auth/availability.ts";
import {
  bearerToken,
  defaultString,
  disabled,
  invalid,
  normalizeAccessMode,
  normalizeAccountList,
  parseModelParam,
  normalizeDisabledModelList,
  uniqueSorted,
  valid,
  visionForCustomModel,
} from "#auth/helpers.ts";

export { isAuthlessProvider, isAuthlessProviderAccountId, parseModelParam } from "#auth/helpers.ts";

const VALID_TTL_SECONDS = 45;
const INVALID_TTL_SECONDS = 10;

export class AuthService {
  private readonly registry: Registry;
  private readonly redis: OpendumRedis;
  private readonly customProviders: CustomProviderReader;

  constructor(
    registry: Registry,
    redis: OpendumRedis,
    customProviders: CustomProviderReader = createCustomStore()
  ) {
    this.registry = registry;
    this.redis = redis;
    this.customProviders = customProviders;
  }

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

  async disabledModelSetForUser(userId: string): Promise<Set<string>> {
    const cached = await this.getCachedDisabledModels(userId);
    if (cached) return new Set(cached);
    const rows = await listDisabledModelsByUser(userId);
    const modelList = normalizeDisabledModelList(this.registry, rows.map((row) => row.trim()));
    await this.setCachedDisabledModels(userId, modelList);
    return new Set(modelList);
  }

  async isModelDisabledForUser(userId: string, model: string): Promise<boolean> {
    const set = await this.disabledModelSetForUser(userId);
    return set.has(this.registry.resolveAlias(model));
  }

  async getAccountModelAvailabilityWithSharing(
    userId: string,
    includeShared: boolean,
    options: { includeInactiveAccounts?: boolean } = {}
  ): Promise<AccountModelAvailability> {
    return computeAccountModelAvailability(
      this.registry,
      (id) => this.customProviderModelSets(id),
      userId,
      includeShared,
      options
    );
  }

  isModelUsableByAccounts(model: string, availability: AccountModelAvailability): boolean {
    return isModelUsableByAccountsImpl(this.registry, model, availability);
  }

  isModelUsableBySharedAccounts(
    model: string,
    availability: AccountModelAvailability
  ): boolean {
    return isModelUsableBySharedAccountsImpl(this.registry, model, availability);
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

  private isCodexChatGPTModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  private codexChatGPTModels(): string[] {
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical) values.add(canonical);
      if (upstream) values.add(upstream);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  private getRateLimitRules(apiKeyId: string): Promise<RateLimitRule[]> {
    return authCache.getRateLimitRules(apiKeyId);
  }

  private resultFromCache(cached: CacheValue): AuthResult {
    return authCache.resultFromCache(cached);
  }

  private getCachedAPIKeyValidation(keyHash: string): Promise<CacheValue | null> {
    return authCache.getCachedAPIKeyValidation(this.redis, keyHash);
  }

  private setCachedAPIKeyValidation(keyHash: string, value: CacheValue, ttlSeconds: number): Promise<void> {
    return authCache.setCachedAPIKeyValidation(this.redis, keyHash, value, ttlSeconds);
  }

  private touchAPIKeyLastUsed(apiKeyId: string): Promise<void> {
    return authCache.touchAPIKeyLastUsedThrottled(this.redis, apiKeyId);
  }

  private getCachedDisabledModels(userId: string): Promise<string[] | null> {
    return authCache.getCachedDisabledModels(this.redis, this.registry, userId);
  }

  private setCachedDisabledModels(userId: string, models: string[]): Promise<void> {
    return authCache.setCachedDisabledModels(this.redis, this.registry, userId, models);
  }

  private async customModelResult(
    userId: string,
    slug: string,
    rawModel: string
  ): Promise<ModelValidationResult | null> {
    const custom = await this.customProviders.getProvider(userId, slug);
    if (!custom) return null;
    const rows = await this.customProviders.listModels(custom.id);
    for (const row of rows) {
      if (row.modelId !== rawModel) continue;
      const result = valid(slug, `${slug}/${rawModel}`);
      if (row.aliased) {
        const canonical = this.registry.resolveAlias(row.modelId);
        if (this.registry.isSupported(canonical)) result.alias = canonical;
      }
      result.vision = visionForCustomModel(this.registry, row);
      return result;
    }
    return invalid(
      slug,
      rawModel,
      `Model "${rawModel}" is not registered under your custom provider "${slug}".`,
      "model",
      "invalid_model"
    );
  }

  private async customProviderModelSets(userId: string) {
    const aliased = new Map<string, Set<string>>();
    const standalone = new Map<string, string[]>();
    const providers = await this.customProviders.listProviders(userId);
    for (const custom of providers) {
      const rows = await this.customProviders.listModels(custom.id);
      for (const row of rows) {
        const canonical = this.registry.resolveAlias(row.modelId);
        if (row.aliased && this.registry.isSupported(canonical)) {
          const set = aliased.get(custom.slug) ?? new Set<string>();
          set.add(canonical);
          aliased.set(custom.slug, set);
          continue;
        }
        const list = standalone.get(custom.slug) ?? [];
        list.push(row.modelId);
        standalone.set(custom.slug, list);
      }
    }
    return { aliased, standalone };
  }

  private async usableModelCandidates(
    userId: string,
    provider: string | null,
    mode: string,
    modelSet: Set<string>,
    roamingEnabled: boolean
  ): Promise<string[]> {
    const candidates = provider ? this.registry.modelsForProvider(provider) : this.registry.allModels();
    const disabledSet = await this.disabledModelSetForUser(userId);
    const availability = await this.getAccountModelAvailabilityWithSharing(userId, roamingEnabled);
    const values: string[] = [];
    for (const candidate of candidates) {
      const canonical = this.registry.resolveAlias(candidate);
      if (disabledSet.has(canonical)) continue;
      const usable =
        this.isModelUsableByAccounts(canonical, availability) ||
        (roamingEnabled && this.isModelUsableBySharedAccounts(canonical, availability));
      if (!usable) continue;
      if (mode === "whitelist" && !modelSet.has(canonical)) continue;
      if (mode === "blacklist" && modelSet.has(canonical)) continue;
      values.push(candidate);
    }
    return values;
  }

  private invalidModelResult(
    provider: string | null,
    model: string,
    modelParam: string,
    candidates: string[] | null
  ): ModelValidationResult {
    const suggestions = this.registry.suggestedModels(model, provider, candidates, 5);
    const suggestionMessage =
      suggestions.length > 0
        ? ` Did you mean: ${suggestions.join(", ")} ?`
        : " Use GET /v1/models for the full list.";
    return invalid(provider, model, `Invalid model: ${modelParam}.${suggestionMessage}`, "model", "invalid_model");
  }

  private normalizeModelList(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const model = this.registry.resolveAlias(trimmed);
      if (this.registry.isSupported(model)) result.push(model);
    }
    return uniqueSorted(result);
  }

  private isModelListed(modelSet: Set<string>, model: string, provider: string | null): boolean {
    if (modelSet.has(model)) return true;
    return provider !== null && modelSet.has(`${provider}/${model}`);
  }

  private normalizeModelAccessList(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      let trimmed = value.trim();
      if (!trimmed) continue;
      if (this.registry.isSupported(trimmed)) trimmed = this.registry.resolveAlias(trimmed);
      result.push(trimmed);
    }
    return uniqueSorted(result);
  }
}
