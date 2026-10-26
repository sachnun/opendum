import { describe, expect, it } from "bun:test";
import type { ProviderAccount } from "@opendum/providers";
import {
  Antigravity,
  Generic,
  Kiro,
  tierFor,
} from "../core/tiers.js";
import type { ProviderRoutingOptions, ProviderScore } from "../core/provider-performance.js";
import { Priority, Sticky, compose } from "../core/routing.js";
import { paidTier } from "../core/service-helpers.js";

function account(id: string, provider: string, extra: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id, userId: "u", provider, status: "active", lastUsedAt: null, ...extra } as unknown as ProviderAccount;
}

function scores(entries: Record<string, number>): Map<string, ProviderScore> {
  return new Map(
    Object.entries(entries).map(([provider, score]) => [
      provider,
      { provider, score, ttftMs: score, tokenRate: 0, samples: 5 },
    ])
  );
}

describe("account tier policies", () => {
  it("classifies antigravity tiers without falling back to the generic list", () => {
    const policy = tierFor("antigravity");
    expect(policy).toBeInstanceOf(Antigravity);
    expect(policy.isPaid("paid")).toBe(true);
    expect(policy.isPaid("standard-tier")).toBe(true);
    expect(policy.isPaid("  G1-Ultra ")).toBe(true);
    expect(policy.isPaid("pro")).toBe(false);
    expect(policy.isPaid(null)).toBe(false);
    expect(policy.isPaid("")).toBe(false);
  });

  it("classifies kiro tiers", () => {
    const policy = tierFor("kiro");
    expect(policy).toBeInstanceOf(Kiro);
    for (const tier of ["pro", "pro+", "pro-plus", "power"]) {
      expect(policy.isPaid(tier)).toBe(true);
    }
    expect(policy.isPaid("plus")).toBe(false);
    expect(policy.isPaid(null)).toBe(false);
  });

  it("falls back to the generic paid set for other providers", () => {
    const policy = tierFor("openai");
    expect(policy).toBeInstanceOf(Generic);
    for (const tier of ["plus", "team", "business", "enterprise", "edu", "hc"]) {
      expect(policy.isPaid(tier)).toBe(true);
    }
    expect(policy.isPaid("free")).toBe(false);
    expect(policy.isPaid(null)).toBe(false);
  });

  it("keeps the service-helpers wrapper behavior", () => {
    expect(paidTier("antigravity", "g1-pro")).toBe(true);
    expect(paidTier("antigravity", "pro")).toBe(false);
    expect(paidTier("kiro", "power")).toBe(true);
    expect(paidTier("opencode", "free")).toBe(false);
  });
});

describe("routing strategies", () => {
  it("orders cross-provider candidates by priority with paid-first groups", () => {
    const strategy = new Priority();
    const ordered = strategy.order(
      [
        account("slow-1", "slow"),
        account("fast-free", "fast"),
        account("fast-paid", "fast", { tier: "plus" }),
        account("slow-paid", "slow", { tier: "pro" }),
      ],
      { crossProvider: true, priority: ["slow", "fast"] }
    );
    expect(ordered.map((item) => item.id)).toEqual(["slow-paid", "slow-1", "fast-paid", "fast-free"]);
  });

  it("applies paid-first without provider grouping for a fixed provider", () => {
    const strategy = new Priority();
    const ordered = strategy.order(
      [account("free-1", "fast"), account("paid-1", "fast", { tier: "plus" })],
      { crossProvider: false, priority: ["fast"] }
    );
    expect(ordered.map((item) => item.id)).toEqual(["paid-1", "free-1"]);
  });

  it("keeps the priority order when routing options carry no scores", () => {
    const strategy = new Priority();
    const routingOptions: ProviderRoutingOptions = { scores: scores({}), bufferRatio: 0.5, explorationRate: 1 };
    const ordered = strategy.order([account("b", "beta"), account("a", "alpha")], {
      crossProvider: true,
      priority: ["alpha", "beta"],
      routingOptions,
    });
    expect(ordered.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("promotes the sticky session account", () => {
    const candidates = [account("a", "one"), account("b", "two"), account("c", "three")];
    expect(new Sticky("b").order(candidates).map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(new Sticky("missing").order(candidates)).toBe(candidates);
    expect(new Sticky(null).order(candidates)).toBe(candidates);
  });

  it("ignores synthetic sticky ids", () => {
    const candidates = [account("a", "one"), account("authless:one", "one")];
    const ordered = new Sticky("authless:one").order(candidates);
    expect(ordered).toBe(candidates);
  });

  it("composes priority ordering with sticky promotion", () => {
    const strategy = compose(new Priority(), new Sticky("slow-1"));
    const ordered = strategy.order(
      [account("fast-1", "fast", { tier: "plus" }), account("slow-1", "slow")],
      { crossProvider: true, priority: ["fast", "slow"] }
    );
    expect(ordered.map((item) => item.id)).toEqual(["slow-1", "fast-1"]);
  });
});
