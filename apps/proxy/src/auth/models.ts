import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type Redis from "ioredis";
import type { ProxyDB } from "../db/index.js";
import { schema } from "../db/index.js";
import type { Registry } from "../registry/index.js";
import { normalizeProviderAlias } from "../registry/index.js";
import { getCachedDisabledModels, setCachedDisabledModels } from "./cache.js";
import type { AccountModelAvailability, ModelAccess, ModelValidationResult } from "./types.js";
import { normalizeAccessMode, normalizeAccountList } from "./service.js";
import { authlessProviderNames } from "./authless-providers.js";

export class AuthModelService {
  constructor(
    private db: ProxyDB | null,
    private redis: Redis | null,
    private registry: Registry,
  ) {}

  validateModel(modelParam: string): ModelValidationResult {
    const { provider, rawModel } = parseModelParam(modelParam);
    const model = this.registry.resolveAlias(rawModel);

    if (provider !== null && provider === "codex" && !this.isCodexChatGPTModel(model)) {
      const supported = this.codexChatGPTModels().join(", ");
      return {
        valid: false,
        provider,
        model,
        error: `Model "${rawModel}" is not supported for Codex when using a ChatGPT account. Use one of: ${supported}.`,
        param: "model",
        code: "unsupported_codex_chatgpt_model",
      };
    }
    if (!this.registry.isSupported(model)) {
      return this.invalidModelResult(provider, rawModel, modelParam, null);
    }
    if (provider !== null && !this.registry.isSupportedByProvider(model, provider)) {
      const supported = this.registry.providersForModel(model).join(", ");
      return {
        valid: false,
        provider,
        model,
        error: `Model "${model}" is not supported by provider "${provider}". Supported providers: ${supported}`,
        param: "model",
        code: "invalid_provider_model",
      };
    }
    return { valid: true, provider, model, error: "", param: "", code: "" };
  }

  isCodexChatGPTModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    for (const [canonical, upstream] of this.registry.providerModelMapFor("codex")) {
      if (canonical.toLowerCase() === normalized || upstream.toLowerCase() === normalized) return true;
    }
    return false;
  }

  codexChatGPTModels(): string[] {
    const values = new Set<string>();
    for (const [canonical, upstream] of this.registry.providerModelMapFor("codex")) {
      for (const value of [canonical, upstream]) {
        if (value !== "") values.add(value);
      }
    }
    return [...values].sort();
  }

  async validateModelForUser(userId: string, modelParam: string, access: ModelAccess): Promise<ModelValidationResult> {
    const { provider, rawModel } = parseModelParam(modelParam);
    const mode = normalizeAccessMode(access.mode);
    const modelSet = new Set(this.normalizeModelList(access.models));

    const candidates = await this.usableModelCandidates(userId, provider, mode, modelSet, access.roamingEnabled);

    const base = this.validateModel(modelParam);
    if (!base.valid) {
      if (base.code === "invalid_model") {
        return this.invalidModelResult(provider, rawModel, modelParam, candidates);
      }
      return base;
    }

    if (mode === "whitelist") {
      if (!modelSet.has(base.model)) {
        return this.invalidModelResult(base.provider, base.model, modelParam, candidates);
      }
    }
    if (mode === "blacklist") {
      if (modelSet.has(base.model)) {
        return this.invalidModelResult(base.provider, base.model, modelParam, candidates);
      }
    }

    const disabled = await this.isModelDisabledForUser(userId, base.model);
    if (disabled) {
      return {
        valid: false,
        provider: base.provider,
        model: base.model,
        error: `Model "${base.model}" is disabled. Enable it from Dashboard > Models first.`,
        param: "model",
        code: "model_disabled",
      };
    }

    return base;
  }

  invalidModelResult(provider: string | null, model: string, modelParam: string, candidates: string[] | null): ModelValidationResult {
    const suggestions = this.registry.suggestedModels(model, provider, candidates, 5);
    let suggestionMessage = " Use GET /v1/models for the full list.";
    if (suggestions.length > 0) {
      suggestionMessage = " Did you mean: " + suggestions.join(", ") + " ?";
    }
    return {
      valid: false,
      provider,
      model,
      error: "Invalid model: " + modelParam + "." + suggestionMessage,
      param: "model",
      code: "invalid_model",
    };
  }

  async usableModelCandidates(userId: string, provider: string | null, mode: string, modelSet: Set<string>, roamingEnabled: boolean): Promise<string[]> {
    let candidates = this.registry.allModels();
    if (provider !== null) {
      candidates = this.registry.modelsForProvider(provider);
    }

    if (!this.db) {
      return filterCandidatesByAccess(candidates, mode, modelSet);
    }

    const disabledSet = await this.disabledModelSetForUser(userId);
    const availability = await this.getAccountModelAvailabilityWithSharing(userId, roamingEnabled);

    const values: string[] = [];
    for (const candidate of candidates) {
      const canonical = this.registry.resolveAlias(candidate);
      if (disabledSet.has(canonical)) continue;
      if (!this.isModelUsableByAccounts(canonical, availability, roamingEnabled)) continue;
      if (mode === "whitelist") {
        if (!modelSet.has(canonical)) continue;
      }
      if (mode === "blacklist") {
        if (modelSet.has(canonical)) continue;
      }
      values.push(candidate);
    }
    return values;
  }

  isModelUsableByAccounts(model: string, availability: AccountModelAvailability, includeShared: boolean): boolean {
    if (this.isModelUsableByOwnedAccounts(model, availability)) return true;
    if (!includeShared) return false;
    return this.isModelUsableBySharedAccounts(model, availability);
  }

  async disabledModelSetForUser(userId: string): Promise<Set<string>> {
    const cached = await getCachedDisabledModels(this.redis, userId);
    if (cached) return new Set(cached);

    if (!this.db) return new Set();

    const rows = await this.db.select({ model: schema.disabledModel.model }).from(schema.disabledModel).where(eq(schema.disabledModel.userId, userId));
    const modelList = this.normalizeModelList(rows.map((row) => this.registry.resolveAlias(row.model)));
    await setCachedDisabledModels(this.redis, userId, modelList);
    return new Set(modelList);
  }

  async isModelDisabledForUser(userId: string, model: string): Promise<boolean> {
    const set = await this.disabledModelSetForUser(userId);
    return set.has(this.registry.resolveAlias(model));
  }

  async getAccountModelAvailabilityWithSharing(userId: string, includeShared: boolean): Promise<AccountModelAvailability> {
    const availability: AccountModelAvailability = {
      activeProviders: new Set(),
      accountCountByProvider: new Map(),
      disabledCountByProviderModel: new Map(),
      activeAccountIDsByProvider: new Map(),
      accountTierByID: new Map(),
      authlessProviderModels: new Map(),
      sharedAccountCountByProvider: new Map(),
      sharedDisabledCountByProviderModel: new Map(),
      sharedAccountTiersByProvider: new Map(),
    };

    for (const provider of authlessProviderNames) {
      availability.activeProviders.add(provider);
      availability.accountCountByProvider.set(provider, 1);
      availability.activeAccountIDsByProvider.set(provider, [provider]);
    }
    for (const [provider, models] of this.registry.authlessProviderModels()) {
      if (models.length === 0) continue;
      availability.activeProviders.add(provider);
      availability.accountCountByProvider.set(provider, 1);
      availability.activeAccountIDsByProvider.set(provider, [provider]);
      if (!availability.authlessProviderModels.has(provider)) {
        availability.authlessProviderModels.set(provider, new Set());
      }
      for (const model of models) {
        availability.authlessProviderModels.get(provider)!.add(model);
      }
    }

    if (!this.db) return availability;

    const now = new Date();
    const accounts = await this.db
      .select({
        id: schema.providerAccount.id,
        provider: schema.providerAccount.provider,
        tier: schema.providerAccount.tier,
      })
      .from(schema.providerAccount)
      .where(
        and(
          eq(schema.providerAccount.userId, userId),
          eq(schema.providerAccount.isActive, true),
          or(isNull(schema.providerAccount.disabledUntil), sql`${schema.providerAccount.disabledUntil} <= ${now}`),
        ),
      );

    const accountProvider = new Map<string, string>();
    const accountIDs: string[] = [];
    for (const account of accounts) {
      availability.activeProviders.add(account.provider);
      availability.accountCountByProvider.set(account.provider, (availability.accountCountByProvider.get(account.provider) ?? 0) + 1);
      const ids = availability.activeAccountIDsByProvider.get(account.provider) ?? [];
      ids.push(account.id);
      availability.activeAccountIDsByProvider.set(account.provider, ids);
      accountProvider.set(account.id, account.provider);
      accountIDs.push(account.id);
      if (account.tier !== null && account.tier.trim() !== "") {
        availability.accountTierByID.set(account.id, account.tier.trim().toLowerCase());
      }
    }

    if (accountIDs.length > 0) {
      const disabledRows = await this.db
        .select({
          providerAccountId: schema.providerAccountDisabledModel.providerAccountId,
          model: schema.providerAccountDisabledModel.model,
        })
        .from(schema.providerAccountDisabledModel)
        .where(inArray(schema.providerAccountDisabledModel.providerAccountId, accountIDs));
      for (const row of disabledRows) {
        const provider = accountProvider.get(row.providerAccountId);
        if (!provider) continue;
        const key = provider + ":" + this.registry.resolveAlias(row.model);
        availability.disabledCountByProviderModel.set(key, (availability.disabledCountByProviderModel.get(key) ?? 0) + 1);
      }
    }

    if (!includeShared) return availability;

    const sharedAccounts = await this.db
      .select({
        id: schema.providerAccount.id,
        provider: schema.providerAccount.provider,
        tier: schema.providerAccount.tier,
      })
      .from(schema.providerAccount)
      .innerJoin(schema.userSharingSetting, eq(schema.userSharingSetting.userId, schema.providerAccount.userId))
      .where(
        and(
          sql`${schema.providerAccount.userId} != ${userId}`,
          eq(schema.userSharingSetting.enabled, true),
          eq(schema.providerAccount.isActive, true),
          or(isNull(schema.providerAccount.disabledUntil), sql`${schema.providerAccount.disabledUntil} <= ${now}`),
        ),
      );

    const sharedAccountProvider = new Map<string, string>();
    const sharedAccountIDs: string[] = [];
    for (const account of sharedAccounts) {
      availability.sharedAccountCountByProvider.set(account.provider, (availability.sharedAccountCountByProvider.get(account.provider) ?? 0) + 1);
      sharedAccountProvider.set(account.id, account.provider);
      sharedAccountIDs.push(account.id);
      if (account.tier !== null && account.tier.trim() !== "") {
        const tiers = availability.sharedAccountTiersByProvider.get(account.provider) ?? [];
        tiers.push(account.tier.trim().toLowerCase());
        availability.sharedAccountTiersByProvider.set(account.provider, tiers);
      }
    }
    if (sharedAccountIDs.length > 0) {
      const sharedDisabledRows = await this.db
        .select({
          providerAccountId: schema.providerAccountDisabledModel.providerAccountId,
          model: schema.providerAccountDisabledModel.model,
        })
        .from(schema.providerAccountDisabledModel)
        .where(inArray(schema.providerAccountDisabledModel.providerAccountId, sharedAccountIDs));
      for (const row of sharedDisabledRows) {
        const provider = sharedAccountProvider.get(row.providerAccountId);
        if (!provider) continue;
        const key = provider + ":" + this.registry.resolveAlias(row.model);
        availability.sharedDisabledCountByProviderModel.set(key, (availability.sharedDisabledCountByProviderModel.get(key) ?? 0) + 1);
      }
    }

    return availability;
  }

  isModelUsableByOwnedAccounts(model: string, availability: AccountModelAvailability): boolean {
    const canonical = this.registry.resolveAlias(model);
    for (const provider of this.registry.providersForModel(canonical)) {
      let total = availability.accountCountByProvider.get(provider) ?? 0;
      if (total === 0) continue;
      const authlessModels = availability.authlessProviderModels.get(provider);
      if (authlessModels && authlessModels.size > 0) {
        if (!authlessModels.has(canonical)) {
          if (total === 1) continue;
          total--;
        }
      }
      const rule = this.registry.providerAccessRule(canonical, provider);
      if (rule && accessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) {
        let eligible = false;
        for (const accountID of availability.activeAccountIDsByProvider.get(provider) ?? []) {
          if (tierSatisfiesRule(availability.accountTierByID.get(accountID) ?? "", rule.minTier, rule.allowedTiers)) {
            eligible = true;
            break;
          }
        }
        if (!eligible) continue;
      }
      if ((availability.disabledCountByProviderModel.get(provider + ":" + canonical) ?? 0) < total) {
        return true;
      }
    }
    return false;
  }

  isModelUsableBySharedAccounts(model: string, availability: AccountModelAvailability): boolean {
    const canonical = this.registry.resolveAlias(model);
    for (const provider of this.registry.providersForModel(canonical)) {
      const total = availability.sharedAccountCountByProvider.get(provider) ?? 0;
      if (total === 0) continue;
      const rule = this.registry.providerAccessRule(canonical, provider);
      if (rule && accessRuleRestrictsTier(rule.minTier, rule.allowedTiers)) {
        let eligible = false;
        for (const tier of availability.sharedAccountTiersByProvider.get(provider) ?? []) {
          if (tierSatisfiesRule(tier, rule.minTier, rule.allowedTiers)) {
            eligible = true;
            break;
          }
        }
        if (!eligible) continue;
      }
      if ((availability.sharedDisabledCountByProviderModel.get(provider + ":" + canonical) ?? 0) < total) {
        return true;
      }
    }
    return false;
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
}

export function parseModelParam(modelParam: string): { provider: string | null; rawModel: string } {
  const index = modelParam.indexOf("/");
  if (index < 0) return { provider: null, rawModel: modelParam };
  const provider = normalizeProviderAlias(modelParam.slice(0, index));
  const model = modelParam.slice(index + 1);
  return { provider, rawModel: model };
}

function filterCandidatesByAccess(candidates: string[], mode: string, modelSet: Set<string>): string[] {
  const values: string[] = [];
  for (const candidate of candidates) {
    if (mode === "whitelist") {
      if (!modelSet.has(candidate)) continue;
    }
    if (mode === "blacklist") {
      if (modelSet.has(candidate)) continue;
    }
    values.push(candidate);
  }
  return values;
}

export function tierSatisfiesRule(accountTier: string, minTier: string, allowedTiers: string[]): boolean {
  const normalizedAccountTier = normalizeTierAlias(accountTier);
  if (allowedTiers.length > 0) {
    for (const tier of allowedTiers) {
      if (normalizeTierAlias(tier) === normalizedAccountTier) return true;
    }
    return false;
  }

  const required = minTier.trim().toLowerCase();
  if (required === "" || required === "free") return true;
  return normalizedAccountTier === normalizeTierAlias(required);
}

export function accessRuleRestrictsTier(minTier: string, allowedTiers: string[]): boolean {
  if (allowedTiers.length > 0) return true;
  const required = normalizeTierAlias(minTier);
  return required !== "" && required !== "free";
}

export function normalizeTierAlias(tier: string): string {
  const normalized = tier.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "pro-plus" || normalized === "proplus") return "pro+";
  if (normalized === "free-tier") return "free";
  if (normalized === "education" || normalized === "educational" || normalized === "edu" || normalized === "free-educational-quota") return "student";
  return normalized;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((v) => v !== ""))].sort();
}
