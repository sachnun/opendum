import type { Registry } from "@opendum/models/runtime";
import { invalid, valid } from "./model-results.js";
import { parseModelParam } from "./normalize.js";
import type { AccountModelAvailability, ModelValidationResult } from "./types.js";

export class AccessPolicy {
  constructor(private readonly registry: Registry) {}

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

  isModelUsableBySharedAccounts(model: string, availability: AccountModelAvailability): boolean {
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

  invalidModelResult(
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
