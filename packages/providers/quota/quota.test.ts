import { describe, expect, it, setSystemTime } from "bun:test";
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
    expect(clampFraction(0.5)).toBe(0.5);
    expect(clampFraction(-1)).toBe(0);
    expect(clampFraction(2)).toBe(1);
  });

  it("formats numbers", () => {
    expect(displayNumber(42)).toBe(42);
    expect(displayNumber(42.129)).toBe(42.13);
    expect(formatFloat(42)).toBe("42");
    expect(formatFloat(42.5)).toBe("42.50");
  });

  it("parses quota numbers", () => {
    expect(parseQuotaNumber("12.5")).toBe(12.5);
    expect(parseQuotaNumber(7)).toBe(7);
    expect(parseQuotaNumber("nope")).toBe(null);
  });

  it("normalizes reset ISO values", () => {
    expect(parseResetIso("2026-01-01T00:00:00Z")).toBe("2026-01-01T00:00:00.000Z");
    expect(parseResetIso(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(parseResetIso("not-a-date")).toBe(null);
  });

  it("formats time until reset", () => {
    setSystemTime(new Date(1_000_000));
    expect(formatTimeUntilReset(1_000_000 + 90 * 60 * 1000)).toBe("1h 30m");
    expect(formatTimeUntilReset(1_000_000 + 25 * 60 * 1000)).toBe("25m");
    setSystemTime();
    expect(formatTimeUntilReset(1)).toBe("resetting...");
    expect(formatTimeUntilReset(0)).toBe(null);
  });

  it("falls back to free tier", () => {
    expect(quotaFallbackTier({ id: "1", userId: "u", provider: "kiro", tier: "pro" })).toBe("pro");
    expect(quotaFallbackTier({ id: "1", userId: "u", provider: "kiro", tier: null })).toBe("free");
  });
});
