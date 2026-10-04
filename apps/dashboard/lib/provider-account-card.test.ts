import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addAdditionalPlaygroundParams,
  addPlaygroundParam,
  buildDayKeys,
  buildHourKeys,
  collectStatValues,
  compactNumber,
  formatDuration,
  formatSignedPercent,
  formatTierBadgeLabel,
  getAccountHeader,
  getErrorStatusTag,
  getHttpStatusDescription,
  isFreeTierValue,
  isImmediatelyRecoverableErrorCode,
  isPaidTierValue,
  maskSensitiveText,
  normalizePlaygroundEndpoint,
  parseErrorParameters,
  quotaPercentRemaining,
  stripStatusFromErrorMessage,
  type StatMetric,
} from "./provider-account-card";

describe("provider account card helpers", () => {
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

  it("maps status codes", () => {
    assert.equal(getHttpStatusDescription(404), "Not Found");
    assert.equal(getHttpStatusDescription(999), "HTTP Error");
    assert.deepEqual(getErrorStatusTag(429), { code: 429, label: "Rate Limit" });
    assert.equal(getErrorStatusTag(null), null);
  });

  it("strips status prefixes from messages", () => {
    assert.equal(stripStatusFromErrorMessage("[429] error: too many requests", 429), "too many requests");
    assert.equal(stripStatusFromErrorMessage("Error: boom", null), "boom");
  });

  it("normalizes endpoints and parses parameters", () => {
    assert.equal(normalizePlaygroundEndpoint("/v1/messages"), "messages");
    assert.equal(normalizePlaygroundEndpoint("chat/completions"), "chat_completions");
    assert.equal(normalizePlaygroundEndpoint("nope"), null);
    assert.deepEqual(parseErrorParameters('{"a":1}'), { a: 1 });
    assert.equal(parseErrorParameters("[1,2]"), null);
    assert.equal(parseErrorParameters(""), null);
  });

  it("builds playground query parameters", () => {
    const query: Record<string, string> = {};
    addPlaygroundParam(query, { temperature: 0.5, other: "x" }, "temperature");
    assert.equal(query.temperature, "0.5");
    addAdditionalPlaygroundParams(query, { temperature: 1, top_k: 5 });
    assert.equal(query.additional_parameters, '{"top_k":5}');
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

  it("detects recoverable codes and quota percentage", () => {
    assert.equal(isImmediatelyRecoverableErrorCode(429), true);
    assert.equal(isImmediatelyRecoverableErrorCode(502), true);
    assert.equal(isImmediatelyRecoverableErrorCode(400), false);
    assert.equal(quotaPercentRemaining({ remainingFraction: 0.5 } as unknown as Parameters<typeof quotaPercentRemaining>[0]), 50);
  });
});
