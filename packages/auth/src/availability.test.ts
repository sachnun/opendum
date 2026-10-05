import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { isModelUsableByAccounts, isModelUsableBySharedAccounts } from "#auth/availability.ts";
import { emptyAvailability, type AccountModelAvailability } from "#auth/types.ts";

function fakeRegistry(options: {
  canonical?: Record<string, string>;
  providers?: Record<string, string[]>;
  rules?: Record<string, { minTier?: string; allowedTiers?: string[] }>;
} = {}): Registry {
  const canonical = options.canonical ?? {};
  const providers = options.providers ?? {};
  const rules = options.rules ?? {};
  return {
    resolveAlias: (model: string) => canonical[model] ?? model,
    providersForModel: (model: string) => providers[model] ?? [],
    providerAccessRule: (model: string, provider: string) => rules[`${model}:${provider}`] ?? null,
  } as unknown as Registry;
}

function availabilityWith(counts: Record<string, number>): AccountModelAvailability {
  const availability = emptyAvailability();
  for (const [provider, count] of Object.entries(counts)) {
    availability.accountCountByProvider.set(provider, count);
  }
  return availability;
}

describe("isModelUsableByAccounts", () => {
  it("is usable when an account exists and nothing is disabled", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    assert.equal(isModelUsableByAccounts(registry, "gpt", availabilityWith({ antigravity: 1 })), true);
  });

  it("resolves aliases before looking up the provider", () => {
    const registry = fakeRegistry({ canonical: { latest: "gpt-4o" }, providers: { "gpt-4o": ["antigravity"] } });
    assert.equal(isModelUsableByAccounts(registry, "latest", availabilityWith({ antigravity: 1 })), true);
  });

  it("is unusable when every account disables the model", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    const availability = availabilityWith({ antigravity: 2 });
    availability.disabledCountByProviderModel.set("antigravity:gpt", 2);
    assert.equal(isModelUsableByAccounts(registry, "gpt", availability), false);
  });

  it("is usable while at least one account still allows the model", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    const availability = availabilityWith({ antigravity: 2 });
    availability.disabledCountByProviderModel.set("antigravity:gpt", 1);
    assert.equal(isModelUsableByAccounts(registry, "gpt", availability), true);
  });

  it("treats the synthetic authless account as not serving unrelated models", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    const availability = availabilityWith({ antigravity: 1 });
    availability.authlessProviderModels.set("antigravity", new Set(["other-model"]));
    assert.equal(isModelUsableByAccounts(registry, "gpt", availability), false);
  });

  it("keeps real accounts usable alongside the synthetic authless one", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    const availability = availabilityWith({ antigravity: 2 });
    availability.authlessProviderModels.set("antigravity", new Set(["other-model"]));
    assert.equal(isModelUsableByAccounts(registry, "gpt", availability), true);
  });

  it("enforces tier restrictions on active accounts", () => {
    const registry = fakeRegistry({
      providers: { gpt: ["antigravity"] },
      rules: { "gpt:antigravity": { minTier: "pro" } },
    });
    const availability = availabilityWith({ antigravity: 2 });
    availability.activeAccountIdsByProvider.set("antigravity", ["a1", "a2"]);
    availability.accountTierById.set("a1", "free");
    availability.accountTierById.set("a2", "pro");
    assert.equal(isModelUsableByAccounts(registry, "gpt", availability), true);

    availability.accountTierById.set("a2", "free");
    assert.equal(isModelUsableByAccounts(registry, "gpt", availability), false);
  });

  it("is usable through a custom provider alias", () => {
    const registry = fakeRegistry();
    const availability = availabilityWith({ custom: 1 });
    availability.customProviderModels.set("custom", new Set(["my-model"]));
    assert.equal(isModelUsableByAccounts(registry, "my-model", availability), true);
  });

  it("is unusable when no provider serves the model", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    assert.equal(isModelUsableByAccounts(registry, "unknown", availabilityWith({ antigravity: 1 })), false);
  });
});

describe("isModelUsableBySharedAccounts", () => {
  it("is usable when a shared account exists", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    const availability = emptyAvailability();
    availability.sharedAccountCountByProvider.set("antigravity", 1);
    assert.equal(isModelUsableBySharedAccounts(registry, "gpt", availability), true);
  });

  it("is unusable when shared accounts disallow the model", () => {
    const registry = fakeRegistry({ providers: { gpt: ["antigravity"] } });
    const availability = emptyAvailability();
    availability.sharedAccountCountByProvider.set("antigravity", 1);
    availability.sharedDisabledCountByProviderModel.set("antigravity:gpt", 1);
    assert.equal(isModelUsableBySharedAccounts(registry, "gpt", availability), false);
  });

  it("enforces tier restrictions on shared accounts", () => {
    const registry = fakeRegistry({
      providers: { gpt: ["antigravity"] },
      rules: { "gpt:antigravity": { allowedTiers: ["pro"] } },
    });
    const availability = emptyAvailability();
    availability.sharedAccountCountByProvider.set("antigravity", 1);
    availability.sharedAccountTiersByProvider.set("antigravity", ["free"]);
    assert.equal(isModelUsableBySharedAccounts(registry, "gpt", availability), false);

    availability.sharedAccountTiersByProvider.set("antigravity", ["pro"]);
    assert.equal(isModelUsableBySharedAccounts(registry, "gpt", availability), true);
  });
});
