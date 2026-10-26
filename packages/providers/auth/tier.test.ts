import { describe, expect, it } from "bun:test";

import { freeTier, paidTier, tierLabel } from "@opendum/providers/auth/tier";

describe("provider tier classification", () => {
  it("classifies provider specific tiers", () => {
    expect(paidTier("pro", "kiro")).toBe(true);
    expect(paidTier("standard-tier", "antigravity")).toBe(true);
    expect(paidTier("g1-pro", "antigravity")).toBe(true);
    expect(paidTier("free", "kiro")).toBe(false);
  });

  it("classifies generic tiers", () => {
    expect(paidTier("business")).toBe(true);
    expect(paidTier("mystery")).toBe(false);
    expect(freeTier("free")).toBe(true);
    expect(freeTier("free-tier")).toBe(true);
  });

  it("labels tiers", () => {
    expect(tierLabel("free")).toBe("Free");
    expect(tierLabel("pro", "kiro")).toBe("Paid");
    expect(tierLabel("mystery")).toBe("");
  });
});
