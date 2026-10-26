import { describe, expect, it } from "bun:test";
import { Policy } from "@opendum/models/policy";
import type { ModelInfo } from "@opendum/models/registry";

function policyOf(models: Record<string, ModelInfo>): Policy {
  return new Policy({
    info: (model) => models[model] ?? null,
    entries: () => Object.entries(models),
  });
}

describe("Policy", () => {
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

    expect(policy.rule("m", "a")).toEqual({ minTier: "pro", allowedTiers: ["pro", "max"] });
    expect(policy.rule("m", "b")).toBeNull();
    expect(policy.rule("m", "missing")).toBeNull();
    expect(policy.config("m", "b")).toEqual({ authless: true, free: true });
    expect(policy.config("missing", "a")).toBeNull();
  });

  it("detects authless and free models", () => {
    const policy = policyOf({
      flagged: { providers: ["a"], providerConfig: { a: { authless: true, free: true } } },
      plain: { providers: ["a"] },
      freeOnly: { providers: ["a"], providerConfig: { a: { free: true } } },
    });

    expect(policy.isAuthless("flagged", "a")).toBe(true);
    expect(policy.isFree("flagged", "a")).toBe(true);
    expect(policy.isAuthless("freeOnly", "a")).toBe(false);
    expect(policy.isFree("freeOnly", "a")).toBe(true);
    expect(policy.isAuthless("plain", "a")).toBe(false);
  });

  it("groups authless models by provider", () => {
    const policy = policyOf({
      b: { providers: ["p1", "p2"], providerConfig: { p1: { authless: true }, p2: { authless: true } } },
      a: { providers: ["p1"], providerConfig: { p1: { authless: true } } },
      c: { providers: ["p1"] },
    });

    expect(policy.authlessModels()).toEqual(
      new Map([
        ["p1", ["a", "b"]],
        ["p2", ["b"]],
      ])
    );
  });
});
