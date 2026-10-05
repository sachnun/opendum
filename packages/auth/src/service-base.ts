import type { CacheValue } from "#auth/cache.ts";
import * as authCache from "#auth/cache.ts";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import { listDisabledModelsByUser } from "@opendum/database/queries";
import { type CustomProviderReader, createCustomStore } from "#auth/custom-store.ts";
import {
  type AccountModelAvailability,
  type ModelValidationResult,
  type RateLimitRule,
} from "#auth/types.ts";
import {
  computeAccountModelAvailability,
  isModelUsableByAccounts as isModelUsableByAccountsImpl,
  isModelUsableBySharedAccounts as isModelUsableBySharedAccountsImpl,
} from "#auth/availability.ts";
import {
  invalid,
  normalizeDisabledModelList,
  uniqueSorted,
  valid,
  visionForCustomModel,
} from "#auth/helpers.ts";

export class AuthServiceBase {
  protected readonly registry: Registry;
  protected readonly redis: OpendumRedis;
  protected readonly customProviders: CustomProviderReader;

  constructor(
    registry: Registry,
    redis: OpendumRedis,
    customProviders: CustomProviderReader = createCustomStore()
  ) {
    this.registry = registry;
    this.redis = redis;
    this.customProviders = customProviders;
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

  protected isCodexChatGPTModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  protected codexChatGPTModels(): string[] {
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.providerModelMap("codex")) {
      if (canonical) values.add(canonical);
      if (upstream) values.add(upstream);
    }
    return [...values].sort((a, b) => a.localeCompare(b));
  }

  protected getRateLimitRules(apiKeyId: string): Promise<RateLimitRule[]> {
    return authCache.getRateLimitRules(apiKeyId);
  }

  protected resultFromCache(cached: CacheValue) {
    return authCache.resultFromCache(cached);
  }

  protected getCachedAPIKeyValidation(keyHash: string): Promise<CacheValue | null> {
    return authCache.getCachedAPIKeyValidation(this.redis, keyHash);
  }

  protected setCachedAPIKeyValidation(keyHash: string, value: CacheValue, ttlSeconds: number): Promise<void> {
    return authCache.setCachedAPIKeyValidation(this.redis, keyHash, value, ttlSeconds);
  }

  protected touchAPIKeyLastUsed(apiKeyId: string): Promise<void> {
    return authCache.touchAPIKeyLastUsedThrottled(this.redis, apiKeyId);
  }

  protected getCachedDisabledModels(userId: string): Promise<string[] | null> {
    return authCache.getCachedDisabledModels(this.redis, this.registry, userId);
  }

  protected setCachedDisabledModels(userId: string, models: string[]): Promise<void> {
    return authCache.setCachedDisabledModels(this.redis, this.registry, userId, models);
  }

  protected async customModelResult(
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

  protected async customProviderModelSets(userId: string) {
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

  protected async usableModelCandidates(
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

  protected invalidModelResult(
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

  protected normalizeModelList(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const model = this.registry.resolveAlias(trimmed);
      if (this.registry.isSupported(model)) result.push(model);
    }
    return uniqueSorted(result);
  }

  protected isModelListed(modelSet: Set<string>, model: string, provider: string | null): boolean {
    if (modelSet.has(model)) return true;
    return provider !== null && modelSet.has(`${provider}/${model}`);
  }

  protected normalizeModelAccessList(values: string[]): string[] {
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
