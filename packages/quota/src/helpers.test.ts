import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  baseQuotaInfo,
  clampFraction,
  displayNumber,
  errorQuotaInfo,
  expiredQuotaInfo,
  firstNonEmpty,
  formatFloat,
  formatTimeUntilReset,
  formatTimeUntilResetIso,
  parseQuotaArray,
  parseQuotaNumber,
  parseQuotaRecord,
  parseQuotaString,
  parseResetIso,
} from "#quota/lib/helpers.ts";

describe("numeric helpers", () => {
  it("clamps fractions", () => {
    assert.equal(clampFraction(0.5), 0.5);
    assert.equal(clampFraction(-1), 0);
    assert.equal(clampFraction(2), 1);
  });

  it("formats display numbers", () => {
    assert.equal(displayNumber(3), 3);
    assert.equal(displayNumber(3.14159), 3.14);
    assert.equal(displayNumber(2.99), 2.99);
  });

  it("formats floats as strings", () => {
    assert.equal(formatFloat(3), "3");
    assert.equal(formatFloat(3.14159), "3.14");
  });
});

describe("formatTimeUntilReset", () => {
  it("returns null for a non-positive timestamp", () => {
    assert.equal(formatTimeUntilReset(0), null);
    assert.equal(formatTimeUntilReset(-1), null);
  });

  it("reports a passed reset", () => {
    assert.equal(formatTimeUntilReset(Date.now() - 1000), "resetting...");
  });

  it("formats minutes, hours and days", () => {
    assert.equal(formatTimeUntilReset(Date.now() + (29 * 60 + 30) * 1000), "29m");
    assert.equal(formatTimeUntilReset(Date.now() + (61 * 60 + 30) * 1000), "1h 1m");
    assert.equal(formatTimeUntilReset(Date.now() + (90 * 60 + 30) * 1000), "1h 30m");
    assert.equal(formatTimeUntilReset(Date.now() + (49 * 60 * 60 + 30) * 1000), "2d 1h");
    assert.equal(formatTimeUntilReset(Date.now() + (53 * 60 * 60 + 30) * 1000), "2d 5h");
  });

  it("parses and formats iso input", () => {
    assert.equal(formatTimeUntilResetIso(null), null);
    assert.equal(formatTimeUntilResetIso("  "), null);
    assert.equal(formatTimeUntilResetIso("not-a-date"), null);
    assert.equal(formatTimeUntilResetIso(new Date(Date.now() + (125 * 60 + 30) * 1000).toISOString()), "2h 5m");
  });
});

describe("quota parsing", () => {
  it("parses reset timestamps", () => {
    assert.equal(parseResetIso("not-a-date"), null);
    assert.equal(parseResetIso("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z");
    assert.equal(parseResetIso(1_700_000_000_000), new Date(1_700_000_000_000).toISOString());
    assert.equal(parseResetIso(1_700_000_000), new Date(1_700_000_000_000).toISOString());
    assert.equal(parseResetIso({ seconds: 1_700_000_000 }), new Date(1_700_000_000_000).toISOString());
    assert.equal(parseResetIso({ seconds: "1700000000" }), new Date(1_700_000_000_000).toISOString());
    assert.equal(parseResetIso({}), null);
    assert.equal(parseResetIso(null), null);
  });

  it("parses quota numbers", () => {
    assert.equal(parseQuotaNumber(5), 5);
    assert.equal(parseQuotaNumber(" 5.5 "), 5.5);
    assert.equal(parseQuotaNumber(""), null);
    assert.equal(parseQuotaNumber("abc"), null);
    assert.equal(parseQuotaNumber(Number.NaN), null);
    assert.equal(parseQuotaNumber(true), null);
  });

  it("parses strings, records and arrays", () => {
    assert.equal(parseQuotaString("  hi  "), "hi");
    assert.equal(parseQuotaString(5), "");
    assert.deepEqual(parseQuotaRecord({ a: 1 }), { a: 1 });
    assert.equal(parseQuotaRecord([1]), null);
    assert.equal(parseQuotaRecord(null), null);
    assert.deepEqual(parseQuotaArray([1, 2]), [1, 2]);
    assert.deepEqual(parseQuotaArray("x"), []);
  });

  it("returns the first non-empty value", () => {
    assert.equal(firstNonEmpty("", "  ", "b", "c"), "b");
    assert.equal(firstNonEmpty("", "  "), "");
  });
});

describe("quota info builders", () => {
  it("builds a base info object", () => {
    assert.deepEqual(baseQuotaInfo("active", [], "fine"), { status: "active", error: "fine", groups: [] });
  });

  it("builds expired and error info", () => {
    assert.deepEqual(expiredQuotaInfo("gone"), { status: "expired", error: "gone", groups: [] });
    assert.deepEqual(errorQuotaInfo("bad"), { status: "error", error: "bad", groups: [] });
  });
});
