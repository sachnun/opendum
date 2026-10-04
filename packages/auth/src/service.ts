import { hashString } from "@opendum/crypto";
import type { Registry } from "@opendum/models/runtime";
import {
  analyticsVersionBumpKey,
  analyticsVersionKey,
  apiKeyLastUsedKey,
  apiKeyValidationKey,
  disabledModelsKey,
  type OpendumRedis,
} from "@opendum/redis";
import {
  deactivateAPIKey,
  getAPIKeyByHash,
  listAPIKeyRateLimits,
  listActiveAccountTiers,
  listDisabledModelsByAccounts,
  listDisabledModelsByUser,
  listSharedAccounts,
  touchAPIKeyLastUsed,
} from "@opendum/database/queries";
import {
  type CustomProviderModelRecord,
  type CustomProviderReader,
  createCustomStore,
} from "./custom-store.js";
import {
  type AccountAccess,
  type AccountModelAvailability,
  type AuthResult,
  type ModelAccess,
  type ModelValidationResult,
  type RateLimitRule,
  emptyAuthResult,
  emptyAvailability,
} from "./types.js";

const VALID_TTL_SECONDS = 45;
const INVALID_TTL_SECONDS = 10;
const LAST_USED_TTL_SECONDS = 60;
const DISABLED_MODELS_TTL_SECONDS = 60;
const ANALYTICS_VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ANALYTICS_BUMP_TTL_SECONDS = 15;

const AUTHLESS_PROVIDER_NAMES = ["opencode"];

type CacheValue = {
  valid: boolean;
  userId?: string;
  apiKeyId?: string;
  modelAccessMode?: string;
  modelAccessList?: string[];
  accountAccessMode?: string;
  accountAccessList?: string[];
  roamingEnabled?: boolean;
  expiresAtMs?: number;
  rateLimitRules?: RateLimitRule[];
  error?: string;
};

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
    const modelList = this.normalizeDisabledModelList(rows.map((row) => row.trim()));
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
    const availability = emptyAvailability();

    for (const provider of AUTHLESS_PROVIDER_NAMES) {
      availability.activeProviders.add(provider);
      availability.accountCountByProvider.set(provider, 1);
      availability.activeAccountIdsByProvider.set(provider, [provider]);
    }
    for (const [provider, models] of this.registry.authlessProviderModels()) {
      if (models.length === 0) continue;
      availability.activeProviders.add(provider);
      availability.accountCountByProvider.set(
        provider,
        (availability.accountCountByProvider.get(provider) ?? 0) + 1
      );
      availability.activeAccountIdsByProvider.set(provider, [
        ...(availability.activeAccountIdsByProvider.get(provider) ?? []),
        provider,
      ]);
      const set = availability.authlessProviderModels.get(provider) ?? new Set<string>();
      for (const model of models) set.add(model);
      availability.authlessProviderModels.set(provider, set);
    }

    const now = new Date();
    const accounts = await listActiveAccountTiers(userId, now, options.includeInactiveAccounts === true);
    const accountProvider = new Map<string, string>();
    const accountIds: string[] = [];
    for (const account of accounts) {
      availability.activeProviders.add(account.provider);
      availability.accountCountByProvider.set(
        account.provider,
        (availability.accountCountByProvider.get(account.provider) ?? 0) + 1
      );
      const list = availability.activeAccountIdsByProvider.get(account.provider) ?? [];
      list.push(account.id);
      availability.activeAccountIdsByProvider.set(account.provider, list);
      accountProvider.set(account.id, account.provider);
      accountIds.push(account.id);
      if (account.tier && account.tier.trim()) {
        availability.accountTierById.set(account.id, account.tier.trim().toLowerCase());
      }
    }

    if (accountIds.length > 0) {
      const disabledRows = await listDisabledModelsByAccounts(accountIds);
      for (const row of disabledRows) {
        const provider = accountProvider.get(row.providerAccountId);
        if (!provider) continue;
        const key = `${provider}:${this.registry.resolveAlias(row.model)}`;
        availability.disabledCountByProviderModel.set(
          key,
          (availability.disabledCountByProviderModel.get(key) ?? 0) + 1
        );
      }
    }

    const { aliased, standalone } = await this.customProviderModelSets(userId);
    for (const [slug, models] of aliased) {
      if ((availability.accountCountByProvider.get(slug) ?? 0) === 0) continue;
      availability.customProviderModels.set(slug, models);
    }
    for (const [slug, models] of standalone) {
      availability.customProviderStandaloneModels.set(slug, models);
    }

    if (!includeShared) return availability;

    const sharedAccounts = await listSharedAccounts(userId, now);
    const sharedAccountProvider = new Map<string, string>();
    const sharedAccountIds: string[] = [];
    for (const account of sharedAccounts) {
      availability.sharedAccountCountByProvider.set(
        account.provider,
        (availability.sharedAccountCountByProvider.get(account.provider) ?? 0) + 1
      );
      sharedAccountProvider.set(account.id, account.provider);
      sharedAccountIds.push(account.id);
      if (account.tier && account.tier.trim()) {
        const list = availability.sharedAccountTiersByProvider.get(account.provider) ?? [];
        list.push(account.tier.trim().toLowerCase());
        availability.sharedAccountTiersByProvider.set(account.provider, list);
      }
    }
    if (sharedAccountIds.length > 0) {
      const disabledRows = await listDisabledModelsByAccounts(sharedAccountIds);
      for (const row of disabledRows) {
        const provider = sharedAccountProvider.get(row.providerAccountId);
        if (!provider) continue;
        const key = `${provider}:${this.registry.resolveAlias(row.model)}`;
        availability.sharedDisabledCountByProviderModel.set(
          key,
          (availability.sharedDisabledCountByProviderModel.get(key) ?? 0) + 1
        );
      }
    }

    return availability;
  }

  isModelUsableByAccounts(model: string, availability: AccountModelAvailability): boolean {
    const canonical = this.registry.resolveAlias(model);
    for (const provider of this.registry.providersForModel(canonical)) {
      let total = availability.accountCountByProvider.get(provider) ?? 0;
      if (total === 0) continue;
      const authlessModels = availability.authlessProviderModels.get(provider);
      if (authlessModels && !authlessModels.has(canonical)) {
        if (total === 1) continue;
        total -= 1;
      }
      const rule = this.registry.providerAccessRule(canonical, provider);
      if (rule && accessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) {
        const accountIds = availability.activeAccountIdsByProvider.get(provider) ?? [];
        const eligible = accountIds.some((accountId) =>
          tierSatisfiesRule(
            availability.accountTierById.get(accountId) ?? "",
            rule.minTier,
            rule.allowedTiers
          )
        );
        if (!eligible) continue;
      }
      const disabled = availability.disabledCountByProviderModel.get(`${provider}:${canonical}`) ?? 0;
      if (disabled < total) return true;
    }
    for (const [provider, models] of availability.customProviderModels) {
      if (!models.has(canonical)) continue;
      if ((availability.accountCountByProvider.get(provider) ?? 0) > 0) return true;
    }
    return false;
  }

  isModelUsableBySharedAccounts(
    model: string,
    availability: AccountModelAvailability
  ): boolean {
    const canonical = this.registry.resolveAlias(model);
    for (const provider of this.registry.providersForModel(canonical)) {
      const total = availability.sharedAccountCountByProvider.get(provider) ?? 0;
      if (total === 0) continue;
      const rule = this.registry.providerAccessRule(canonical, provider);
      if (rule && accessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) {
        const tiers = availability.sharedAccountTiersByProvider.get(provider) ?? [];
        const eligible = tiers.some((tier) =>
          tierSatisfiesRule(tier, rule.minTier, rule.allowedTiers)
        );
        if (!eligible) continue;
      }
      const disabled = availability.sharedDisabledCountByProviderModel.get(`${provider}:${canonical}`) ?? 0;
      if (disabled < total) return true;
    }
    return false;
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
    if (!userId) return;
    try {
      const updated = await this.redis.set(analyticsVersionBumpKey(userId), "1", {
        NX: true,
        EX: ANALYTICS_BUMP_TTL_SECONDS,
      });
      if (!updated) return;
      const version = await this.redis.incr(analyticsVersionKey(userId));
      if (version === 1) {
        await this.redis.expire(analyticsVersionKey(userId), ANALYTICS_VERSION_TTL_SECONDS);
      }
    } catch {
      return;
    }
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

  private async getRateLimitRules(apiKeyId: string): Promise<RateLimitRule[]> {
    const rows = await listAPIKeyRateLimits(apiKeyId);
    return rows.map((row) => ({
      target: row.target,
      targetType: row.targetType === "family" ? "family" : "model",
      perMinute: row.perMinute,
      perHour: row.perHour,
      perDay: row.perDay,
    }));
  }

  private resultFromCache(cached: CacheValue): AuthResult {
    return {
      valid: true,
      userId: cached.userId ?? "",
      apiKeyId: cached.apiKeyId ?? "",
      modelAccessMode: normalizeAccessMode(cached.modelAccessMode ?? ""),
      modelAccessList: this.normalizeModelAccessList(cached.modelAccessList ?? []),
      accountAccessMode: normalizeAccessMode(cached.accountAccessMode ?? ""),
      accountAccessList: normalizeAccountList(cached.accountAccessList ?? []),
      roamingEnabled: Boolean(cached.roamingEnabled),
      rateLimitRules: cached.rateLimitRules ?? [],
      error: "",
    };
  }

  private async getCachedAPIKeyValidation(keyHash: string): Promise<CacheValue | null> {
    try {
      const raw = await this.redis.get(apiKeyValidationKey(keyHash));
      if (!raw) return null;
      return JSON.parse(raw) as CacheValue;
    } catch {
      return null;
    }
  }

  private async setCachedAPIKeyValidation(
    keyHash: string,
    value: CacheValue,
    ttlSeconds: number
  ): Promise<void> {
    try {
      await this.redis.set(apiKeyValidationKey(keyHash), JSON.stringify(value), {
        EX: Math.max(1, Math.round(ttlSeconds)),
      });
    } catch {
      return;
    }
  }

  private async touchAPIKeyLastUsed(apiKeyId: string): Promise<void> {
    if (!apiKeyId) return;
    try {
      const updated = await this.redis.set(apiKeyLastUsedKey(apiKeyId), "1", {
        NX: true,
        EX: LAST_USED_TTL_SECONDS,
      });
      if (!updated) return;
      await touchAPIKeyLastUsed(apiKeyId);
    } catch {
      return;
    }
  }

  private async getCachedDisabledModels(userId: string): Promise<string[] | null> {
    try {
      const raw = await this.redis.get(disabledModelsKey(userId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { models?: string[] };
      return this.normalizeDisabledModelList(parsed.models ?? []);
    } catch {
      return null;
    }
  }

  private async setCachedDisabledModels(userId: string, models: string[]): Promise<void> {
    try {
      await this.redis.set(
        disabledModelsKey(userId),
        JSON.stringify({ models: this.normalizeDisabledModelList(models) }),
        { EX: DISABLED_MODELS_TTL_SECONDS }
      );
    } catch {
      return;
    }
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

  private normalizeDisabledModelList(values: string[]): string[] {
    const result: string[] = [];
    for (const value of values) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const model = this.registry.resolveAlias(trimmed);
      result.push(this.registry.isSupported(model) ? model : trimmed);
    }
    return uniqueSorted(result);
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

export function isAuthlessProvider(provider: string): boolean {
  return AUTHLESS_PROVIDER_NAMES.includes(provider);
}

export function parseModelParam(modelParam: string): [string | null, string] {
  const index = modelParam.indexOf("/");
  if (index < 0) return [null, modelParam];
  return [normalizeProviderAlias(modelParam.slice(0, index)), modelParam.slice(index + 1)];
}

export function isAuthlessProviderAccountId(accountId: string): boolean {
  return AUTHLESS_PROVIDER_NAMES.includes(accountId) || accountId.startsWith("authless:");
}

function normalizeProviderAlias(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeAccessMode(mode: string): string {
  return mode === "whitelist" || mode === "blacklist" ? mode : "all";
}

function normalizeAccountList(values: string[]): string[] {
  return uniqueSorted(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort((a, b) => a.localeCompare(b));
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

function normalizeTierAlias(tier: string): string {
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (
    normalized === "education" ||
    normalized === "educational" ||
    normalized === "edu" ||
    normalized === "free-educational-quota"
  ) {
    return "student";
  }
  return normalized;
}

function tierSatisfiesRule(
  accountTier: string,
  minTier: string | undefined,
  allowedTiers: string[] | undefined
): boolean {
  const normalizedAccountTier = normalizeTierAlias(accountTier);
  if (allowedTiers && allowedTiers.length > 0) {
    return allowedTiers.some((tier) => normalizeTierAlias(tier) === normalizedAccountTier);
  }
  const required = (minTier ?? "").trim().toLowerCase();
  if (!required || required === "free") return true;
  return normalizedAccountTier === normalizeTierAlias(required);
}

function accessRuleRestrictsTier(
  minTier: string | undefined,
  allowedTiers: string[] | undefined
): boolean {
  if (allowedTiers && allowedTiers.length > 0) return true;
  const required = normalizeTierAlias(minTier ?? "");
  return required !== "" && required !== "free";
}

function visionForCustomModel(
  registry: Registry,
  row: CustomProviderModelRecord
): boolean {
  const candidates = [row.upstream, row.modelId].filter(
    (value): value is string => Boolean(value && value.length > 0)
  );
  for (const candidate of candidates) {
    const info = registry.modelInfo(candidate);
    if (!info || info.modalities == null) continue;
    return (info.modalities.input ?? []).includes("image");
  }
  return true;
}

function valid(provider: string | null, model: string): ModelValidationResult {
  return {
    valid: true,
    provider,
    model,
    alias: "",
    vision: null,
    error: "",
    param: "",
    code: "",
  };
}

function invalid(
  provider: string | null,
  model: string,
  error: string,
  param: string,
  code: string
): ModelValidationResult {
  return {
    valid: false,
    provider,
    model,
    alias: "",
    vision: null,
    error,
    param,
    code,
  };
}

function disabled(provider: string | null, model: string): ModelValidationResult {
  return invalid(
    provider,
    model,
    `Model "${model}" is disabled. Enable it from Web > Models first.`,
    "model",
    "model_disabled"
  );
}
