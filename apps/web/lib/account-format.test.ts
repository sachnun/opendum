import { describe, expect, it } from "bun:test";

import {
  buildDayKeys,
  buildHourKeys,
  collectStatValues,
  compactNumber,
  formatDuration,
  formatSignedPercent,
  formatTierBadgeLabel,
  getAccountHeader,
  isFreeTierValue,
  isPaidTierValue,
  maskSensitiveText,
  type StatMetric,
} from "./account-format";

describe("account format helpers", () => {
  it("formats durations and numbers", () => {
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(1500)).toBe("1.50s");
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(1500)).toBe("1.5K");
    expect(compactNumber(2_000_000)).toBe("2M");
    expect(formatSignedPercent(5.55)).toBe("+ 5.6%");
    expect(formatSignedPercent(-2)).toBe("- 2%");
  });

  it("collects finite stat values", () => {
    const metric = (key: string, numericValue: number) => ({ key, label: key, value: "", numericValue, formatDelta: () => "" }) as StatMetric;
    expect(collectStatValues([metric("a", 1), metric("b", Number.NaN)])).toEqual({ a: 1 });
  });

  it("builds ascending UTC keys", () => {
    const hours = buildHourKeys(3);
    expect(hours.length).toBe(3);
    expect([...hours].sort()).toEqual(hours);
    const days = buildDayKeys(2);
    expect(days.length).toBe(2);
    expect([...days].sort()).toEqual(days);
  });

  it("classifies tiers", () => {
    expect(isPaidTierValue("pro", "kiro")).toBe(true);
    expect(isFreeTierValue("free")).toBe(true);
    expect(formatTierBadgeLabel("free")).toBe("Free");
    expect(formatTierBadgeLabel("pro", "kiro")).toBe("Paid");
    expect(formatTierBadgeLabel("mystery")).toBe("");
  });

  it("masks sensitive text", () => {
    expect(maskSensitiveText("abc")).toBe("•••");
  });

  it("derives the account header", () => {
    const header = getAccountHeader({ name: "Foo", email: "a@b.com" } as unknown as Parameters<typeof getAccountHeader>[0]);
    expect(header).toEqual({ title: "Foo", subtitle: "a@b.com" });
  });
});
