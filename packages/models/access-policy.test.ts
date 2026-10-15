import { describe, expect, it } from "bun:test";
import { AccessPolicy } from "./access-policy.ts";
import type { ModelInfo } from "./registry.ts";

function policyOf(models: Record<string, ModelInfo>): AccessPolicy {
  return new AccessPolicy({
    info: (model) => models[model] ?? null,
    entries: () => Object.entries(models),
  });
}

describe("AccessPolicy", () => {
  it("reads provider access rules and configs", () => {
    const policy = policyOf({
      m: {
        providers: ["a", "b"],
        providerConfig: {
          a: { minTier: "pro", allowedTiers: ["pro", "max"] },
          b: { authless: true, free: true },
        },
      },
    });

    expect(policy.providerAccessRule("m", "a")).toEqual({ minTier: "pro", allowedTiers: ["pro", "max"] });
    expect(policy.providerAccessRule("m", "b")).toBeNull();
    expect(policy.providerAccessRule("m", "missing")).toBeNull();
    expect(policy.providerModelConfig("m", "b")).toEqual({ authless: true, free: true });
    expect(policy.providerModelConfig("missing", "a")).toBeNull();
  });

  it("detects authless and free models", () => {
    const policy = policyOf({
      flagged: { providers: ["a"], providerConfig: { a: { authless: true, free: true } } },
      plain: { providers: ["a"] },
      freeOnly: { providers: ["a"], providerConfig: { a: { free: true } } },
    });

    expect(policy.isAuthlessProviderModel("flagged", "a")).toBe(true);
    expect(policy.isFreeProviderModel("flagged", "a")).toBe(true);
    expect(policy.isAuthlessProviderModel("freeOnly", "a")).toBe(false);
    expect(policy.isFreeProviderModel("freeOnly", "a")).toBe(true);
    expect(policy.isAuthlessProviderModel("plain", "a")).toBe(false);
  });

  it("groups authless models by provider", () => {
    const policy = policyOf({
      b: { providers: ["p1", "p2"], providerConfig: { p1: { authless: true }, p2: { authless: true } } },
      a: { providers: ["p1"], providerConfig: { p1: { authless: true } } },
      c: { providers: ["p1"] },
    });

    expect(policy.authlessProviderModels()).toEqual(
      new Map([
        ["p1", ["a", "b"]],
        ["p2", ["b"]],
      ])
    );
  });
});
