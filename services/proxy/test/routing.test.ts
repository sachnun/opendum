import { describe, expect, it } from "bun:test";
import type { ProviderAccount } from "@opendum/providers";
import {
  AntigravityTierPolicy,
  GenericTierPolicy,
  KiroTierPolicy,
  tierPolicyFor,
} from "../core/account-tier-policy.js";
import type { ProviderRoutingOptions, ProviderScore } from "../core/provider-performance.js";
import { PriorityOrderStrategy, StickySessionStrategy, composeRoutingStrategies } from "../core/routing.js";
import { isPaidAccountTier } from "../core/service-helpers.js";

function account(id: string, provider: string, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id, userId: "u", provider, status: "active", lastUsedAt: null, ...extra } as unknown as ProviderAccount;
}

function scores(entries: Record<string, number>): Map<string, ProviderScore> {
  return new Map(
    Object.entries(entries).map(([provider, score]) => [
      provider,
      { provider, score, ttftMs: score, tokensPerSecond: 0, samples: 5 },
    ])
  );
}

describe("account tier policies", () => {
  it("classifies antigravity tiers without falling back to the generic list", () => {
    const policy = tierPolicyFor("antigravity");
    expect(policy).toBeInstanceOf(AntigravityTierPolicy);
    expect(policy.isPaid("paid")).toBe(true);
    expect(policy.isPaid("standard-tier")).toBe(true);
    expect(policy.isPaid("  G1-Ultra ")).toBe(true);
    expect(policy.isPaid("pro")).toBe(false);
    expect(policy.isPaid(null)).toBe(false);
    expect(policy.isPaid("")).toBe(false);
  });

  it("classifies kiro tiers", () => {
    const policy = tierPolicyFor("kiro");
    expect(policy).toBeInstanceOf(KiroTierPolicy);
    for (const tier of ["pro", "pro+", "pro-plus", "power"]) {
      expect(policy.isPaid(tier)).toBe(true);
    }
    expect(policy.isPaid("plus")).toBe(false);
    expect(policy.isPaid(null)).toBe(false);
  });

  it("falls back to the generic paid set for other providers", () => {
    const policy = tierPolicyFor("openai");
    expect(policy).toBeInstanceOf(GenericTierPolicy);
    for (const tier of ["plus", "team", "business", "enterprise", "edu", "hc"]) {
      expect(policy.isPaid(tier)).toBe(true);
    }
    expect(policy.isPaid("free")).toBe(false);
    expect(policy.isPaid(null)).toBe(false);
  });

  it("keeps the service-helpers wrapper behavior", () => {
    expect(isPaidAccountTier("antigravity", "g1-pro")).toBe(true);
    expect(isPaidAccountTier("antigravity", "pro")).toBe(false);
    expect(isPaidAccountTier("kiro", "power")).toBe(true);
    expect(isPaidAccountTier("opencode", "free")).toBe(false);
  });
});

describe("routing strategies", () => {
  it("orders cross-provider candidates by priority with paid-first groups", () => {
    const strategy = new PriorityOrderStrategy();
    const ordered = strategy.order(
      [
        account("slow-1", "slow"),
        account("fast-free", "fast"),
        account("fast-paid", "fast", { tier: "plus" }),
        account("slow-paid", "slow", { tier: "pro" }),
      ],
      { crossProvider: true, providerPriority: ["slow", "fast"] }
    );
    expect(ordered.map((item) => item.id)).toEqual(["slow-paid", "slow-1", "fast-paid", "fast-free"]);
  });

  it("applies paid-first without provider grouping for a fixed provider", () => {
    const strategy = new PriorityOrderStrategy();
    const ordered = strategy.order(
      [account("free-1", "fast"), account("paid-1", "fast", { tier: "plus" })],
      { crossProvider: false, providerPriority: ["fast"] }
    );
    expect(ordered.map((item) => item.id)).toEqual(["paid-1", "free-1"]);
  });

  it("keeps the priority order when routing options carry no scores", () => {
    const strategy = new PriorityOrderStrategy();
    const routingOptions: ProviderRoutingOptions = { scores: scores({}), bufferRatio: 0.5, explorationRate: 1 };
    const ordered = strategy.order([account("b", "beta"), account("a", "alpha")], {
      crossProvider: true,
      providerPriority: ["alpha", "beta"],
      routingOptions,
    });
    expect(ordered.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("promotes the sticky session account", () => {
    const candidates = [account("a", "one"), account("b", "two"), account("c", "three")];
    expect(new StickySessionStrategy("b").order(candidates).map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(new StickySessionStrategy("missing").order(candidates)).toBe(candidates);
    expect(new StickySessionStrategy(null).order(candidates)).toBe(candidates);
  });

  it("ignores synthetic sticky ids", () => {
    const candidates = [account("a", "one"), account("authless:one", "one")];
    const ordered = new StickySessionStrategy("authless:one").order(candidates);
    expect(ordered).toBe(candidates);
  });

  it("composes priority ordering with sticky promotion", () => {
    const strategy = composeRoutingStrategies(new PriorityOrderStrategy(), new StickySessionStrategy("slow-1"));
    const ordered = strategy.order(
      [account("fast-1", "fast", { tier: "plus" }), account("slow-1", "slow")],
      { crossProvider: true, providerPriority: ["fast", "slow"] }
    );
    expect(ordered.map((item) => item.id)).toEqual(["slow-1", "fast-1"]);
  });
});
