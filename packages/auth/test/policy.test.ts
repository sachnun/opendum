import { describe, expect, it } from "bun:test";
import type { Registry } from "@opendum/models/runtime";
import { Policy } from "../policy.js";
import { emptyAvailability } from "../types.js";

type Rule = { minTier?: string; allowedTiers?: string[] };

function policyOf(options: {
  aliases?: Record<string, string>;
  supported?: string[];
  providerModels?: Record<string, string[]>;
  rules?: Record<string, Rule>;
  codexModels?: Array<[string, string]>;
  suggestions?: string[];
} = {}): Policy {
  const aliases = options.aliases ?? {};
  const supported = new Set(options.supported ?? []);
  const providerModels = options.providerModels ?? {};
  const rules = options.rules ?? {};
  const registry = {
    resolveAlias: (model: string) => aliases[model] ?? model,
    isSupported: (model: string) => supported.has(model),
    isSupportedByProvider: (model: string, provider: string) => (providerModels[provider] ?? []).includes(model),
    providers: (model: string) =>
      Object.entries(providerModels)
        .filter(([, models]) => models.includes(model))
        .map(([provider]) => provider),
    rule: (model: string, provider: string) => rules[`${model}:${provider}`] ?? null,
    modelMap: () => new Map(options.codexModels ?? []),
    suggestedModels: () => options.suggestions ?? [],
  } as unknown as Registry;
  return new Policy(registry);
}

describe("Policy", () => {
  it("validates supported models and provider prefixes", () => {
    const policy = policyOf({ supported: ["gpt"], providerModels: { openai: ["gpt"] } });

    expect(policy.validateModel("gpt")).toMatchObject({ valid: true, provider: null, model: "gpt" });
    expect(policy.validateModel("openai/gpt")).toMatchObject({ valid: true, provider: "openai" });
    expect(policy.validateModel("kiro/gpt")).toMatchObject({ valid: false, code: "invalid_provider_model" });
    expect(policy.validateModel("kiro/gpt").error).toContain('Supported providers: openai');
  });

  it("resolves aliases before validating", () => {
    const policy = policyOf({ aliases: { fast: "gpt" }, supported: ["gpt"] });

    expect(policy.validateModel("fast")).toMatchObject({ valid: true, model: "gpt" });
  });

  it("suggests models for unknown names", () => {
    const withSuggestions = policyOf({ suggestions: ["gpt"] });
    const withoutSuggestions = policyOf({});

    expect(withSuggestions.validateModel("nope")).toMatchObject({ valid: false, code: "invalid_model" });
    expect(withSuggestions.validateModel("nope").error).toContain("Did you mean: gpt");
    expect(withoutSuggestions.validateModel("nope").error).toContain("Use GET /v1/models");
  });

  it("restricts codex models to the ChatGPT set", () => {
    const withoutMap = policyOf({ supported: ["codex-chat"], providerModels: { codex: ["codex-chat"] } });
    const withMap = policyOf({
      supported: ["codex-chat"],
      providerModels: { codex: ["codex-chat"] },
      codexModels: [["codex-chat", "gpt-5-codex"]],
    });

    expect(withoutMap.validateModel("codex/codex-chat")).toMatchObject({
      valid: false,
      code: "unsupported_codex_chatgpt_model",
    });
    expect(withMap.validateModel("codex/codex-chat")).toMatchObject({ valid: true });
  });

  it("uses account availability and disabled counts", () => {
    const policy = policyOf({ aliases: { fast: "m" }, providerModels: { p: ["m"] } });
    const availability = emptyAvailability();
    availability.accountCountByProvider.set("p", 2);
    availability.disabledCountByProviderModel.set("p:m", 1);

    expect(policy.usable("fast", availability)).toBe(true);
    availability.disabledCountByProviderModel.set("p:m", 2);
    expect(policy.usable("m", availability)).toBe(false);
  });

  it("treats a lone authless account as unavailable for other models", () => {
    const policy = policyOf({ providerModels: { p: ["m"] } });
    const availability = emptyAvailability();
    availability.accountCountByProvider.set("p", 1);
    availability.authlessModels.set("p", new Set(["other"]));

    expect(policy.usable("m", availability)).toBe(false);
    availability.accountCountByProvider.set("p", 2);
    expect(policy.usable("m", availability)).toBe(true);
  });

  it("filters providers by tier rules", () => {
    const policy = policyOf({ providerModels: { p: ["m"] }, rules: { "m:p": { minTier: "pro" } } });
    const availability = emptyAvailability();
    availability.accountCountByProvider.set("p", 1);
    availability.activeAccountIdsByProvider.set("p", ["a1"]);
    availability.accountTierById.set("a1", "free");

    expect(policy.usable("m", availability)).toBe(false);
    availability.accountTierById.set("a1", "pro");
    expect(policy.usable("m", availability)).toBe(true);

    const allowedPolicy = policyOf({ providerModels: { p: ["m"] }, rules: { "m:p": { allowedTiers: ["pro", "max"] } } });
    availability.accountTierById.set("a1", "max");
    expect(allowedPolicy.usable("m", availability)).toBe(true);
  });

  it("counts custom provider models", () => {
    const policy = policyOf({});
    const availability = emptyAvailability();
    availability.accountCountByProvider.set("custom", 1);
    availability.customProviderModels.set("custom", new Set(["m"]));

    expect(policy.usable("m", availability)).toBe(true);
  });

  it("checks shared accounts with tiers and disabled counts", () => {
    const policy = policyOf({ providerModels: { p: ["m"] }, rules: { "m:p": { minTier: "pro" } } });
    const availability = emptyAvailability();
    availability.sharedAccountCountByProvider.set("p", 2);
    availability.sharedAccountTiersByProvider.set("p", ["pro", "free"]);
    availability.sharedDisabledCountByProviderModel.set("p:m", 1);

    expect(policy.usableShared("m", availability)).toBe(true);
    availability.sharedDisabledCountByProviderModel.set("p:m", 2);
    expect(policy.usableShared("m", availability)).toBe(false);

    const freeOnly = emptyAvailability();
    freeOnly.sharedAccountCountByProvider.set("p", 1);
    freeOnly.sharedAccountTiersByProvider.set("p", ["free"]);
    expect(policy.usableShared("m", freeOnly)).toBe(false);
  });
});
