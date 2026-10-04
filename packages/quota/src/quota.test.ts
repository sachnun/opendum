import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampFraction,
  displayNumber,
  formatFloat,
  formatTimeUntilReset,
  parseQuotaNumber,
  parseResetIso,
  quotaFallbackTier,
} from "./index.js";

describe("quota helpers", () => {
  it("clamps fractions", () => {
    assert.equal(clampFraction(0.5), 0.5);
    assert.equal(clampFraction(-1), 0);
    assert.equal(clampFraction(2), 1);
  });

  it("formats numbers", () => {
    assert.equal(displayNumber(42), 42);
    assert.equal(displayNumber(42.129), 42.13);
    assert.equal(formatFloat(42), "42");
    assert.equal(formatFloat(42.5), "42.50");
  });

  it("parses quota numbers", () => {
    assert.equal(parseQuotaNumber("12.5"), 12.5);
    assert.equal(parseQuotaNumber(7), 7);
    assert.equal(parseQuotaNumber("nope"), null);
  });

  it("normalizes reset ISO values", () => {
    assert.equal(parseResetIso("2026-01-01T00:00:00Z"), "2026-01-01T00:00:00.000Z");
    assert.equal(parseResetIso(1_700_000_000), "2023-11-14T22:13:20.000Z");
    assert.equal(parseResetIso("not-a-date"), null);
  });

  it("formats time until reset", () => {
    const future = Date.now() + 90 * 60 * 1000;
    assert.equal(formatTimeUntilReset(future), "1h 30m");
    assert.equal(formatTimeUntilReset(1), "resetting...");
    assert.equal(formatTimeUntilReset(0), null);
  });

  it("falls back to free tier", () => {
    assert.equal(quotaFallbackTier({ id: "1", userId: "u", provider: "kiro", tier: "pro" }), "pro");
    assert.equal(quotaFallbackTier({ id: "1", userId: "u", provider: "kiro", tier: null }), "free");
  });
});
