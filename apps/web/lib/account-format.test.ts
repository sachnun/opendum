import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    assert.equal(formatDuration(null), "-");
    assert.equal(formatDuration(500), "500ms");
    assert.equal(formatDuration(1500), "1.50s");
    assert.equal(compactNumber(999), "999");
    assert.equal(compactNumber(1500), "1.5K");
    assert.equal(compactNumber(2_000_000), "2M");
    assert.equal(formatSignedPercent(5.55), "+ 5.6%");
    assert.equal(formatSignedPercent(-2), "- 2%");
  });

  it("collects finite stat values", () => {
    const metric = (key: string, numericValue: number) => ({ key, label: key, value: "", numericValue, formatDelta: () => "" }) as StatMetric;
    assert.deepEqual(collectStatValues([metric("a", 1), metric("b", Number.NaN)]), { a: 1 });
  });

  it("builds ascending UTC keys", () => {
    const hours = buildHourKeys(3);
    assert.equal(hours.length, 3);
    assert.deepEqual([...hours].sort(), hours);
    const days = buildDayKeys(2);
    assert.equal(days.length, 2);
    assert.deepEqual([...days].sort(), days);
  });

  it("classifies tiers", () => {
    assert.equal(isPaidTierValue("pro", "kiro"), true);
    assert.equal(isFreeTierValue("free"), true);
    assert.equal(formatTierBadgeLabel("free"), "Free");
    assert.equal(formatTierBadgeLabel("pro", "kiro"), "Paid");
    assert.equal(formatTierBadgeLabel("mystery"), "");
  });

  it("masks sensitive text", () => {
    assert.equal(maskSensitiveText("abc"), "•••");
  });

  it("derives the account header", () => {
    const header = getAccountHeader({ name: "Foo", email: "a@b.com" } as unknown as Parameters<typeof getAccountHeader>[0]);
    assert.deepEqual(header, { title: "Foo", subtitle: "a@b.com" });
  });
});
