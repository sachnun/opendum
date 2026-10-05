import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  buildAccountErrorMessage,
  codexUsageLimitDisabledUntil,
  endpointPath,
  extractProviderErrorDetail,
  isAntigravityResourceExhausted,
  prefixWithProvider,
  providerErrorType,
  retryMetadata,
  sanitizedProxyError,
  shouldRotate,
} from "../src/core/transport/errors.ts";

describe("providerErrorType", () => {
  it("maps statuses to error types", () => {
    assert.equal(providerErrorType(401), "authentication_error");
    assert.equal(providerErrorType(403), "authentication_error");
    assert.equal(providerErrorType(408), "timeout_error");
    assert.equal(providerErrorType(429), "rate_limit_error");
    assert.equal(providerErrorType(500), "api_error");
    assert.equal(providerErrorType(400), "invalid_request_error");
    assert.equal(providerErrorType(200), "api_error");
  });
});

describe("extractProviderErrorDetail", () => {
  it("reads nested messages", () => {
    assert.equal(extractProviderErrorDetail(""), "");
    assert.equal(extractProviderErrorDetail("plain"), "plain");
    assert.equal(extractProviderErrorDetail('{"message":"boom"}'), "boom");
    assert.equal(extractProviderErrorDetail('{"error":{"message":"nested"}}'), "nested");
    assert.equal(extractProviderErrorDetail('{"error":"str"}'), "str");
    assert.equal(extractProviderErrorDetail('{"detail":"d"}'), "d");
    assert.equal(extractProviderErrorDetail('{"error_description":"ed"}'), "ed");
    assert.equal(extractProviderErrorDetail('{"errors":[{"message":"first"}]}'), "first");
  });

  it("unwraps nested json strings and truncates", () => {
    assert.equal(extractProviderErrorDetail(JSON.stringify(JSON.stringify({ message: "deep" }))), "deep");
    const long = "x".repeat(400);
    const result = extractProviderErrorDetail(long);
    assert.equal(result.endsWith("...[truncated]"), true);
    assert.equal(result.length < long.length, true);
  });

  it("normalizes whitespace", () => {
    assert.equal(extractProviderErrorDetail("a\n\n  b"), "a b");
  });
});

describe("sanitizedProxyError", () => {
  it("falls back to status text", () => {
    assert.deepEqual(sanitizedProxyError(500, ""), { message: "Provider request failed", type: "api_error" });
    assert.deepEqual(sanitizedProxyError(429, '{"message":"slow down"}'), { message: "slow down", type: "rate_limit_error" });
  });
});

describe("shouldRotate", () => {
  it("flags rotatable statuses", () => {
    for (const status of [500, 429, 408, 404, 403, 402, 401]) assert.equal(shouldRotate(status), true);
    assert.equal(shouldRotate(200), false);
    assert.equal(shouldRotate(400), false);
  });
});

describe("isAntigravityResourceExhausted", () => {
  it("detects resource exhaustion", () => {
    assert.equal(isAntigravityResourceExhausted("antigravity", 429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}'), true);
    assert.equal(isAntigravityResourceExhausted("antigravity", 429, '{"error":{"status":"OTHER"}}'), false);
    assert.equal(isAntigravityResourceExhausted("other", 429, "{}"), false);
    assert.equal(isAntigravityResourceExhausted("antigravity", 500, "{}"), false);
    assert.equal(isAntigravityResourceExhausted("antigravity", 429, "not json"), false);
  });
});

describe("codexUsageLimitDisabledUntil", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("computes reset windows", () => {
    const resetsAt = Math.floor(now.getTime() / 1000) + 100;
    const until = codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: resetsAt } }), now);
    assert.equal(until?.getTime(), resetsAt * 1000);

    const relative = codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 60 } }), now);
    assert.equal(relative?.getTime(), now.getTime() + 60_000);
  });

  it("ignores unrelated responses", () => {
    assert.equal(codexUsageLimitDisabledUntil("other", 429, "{}", now), null);
    assert.equal(codexUsageLimitDisabledUntil("codex", 500, "{}", now), null);
    assert.equal(codexUsageLimitDisabledUntil("codex", 429, "not json", now), null);
    assert.equal(codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: { type: "other" } }), now), null);
    assert.equal(
      codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1 } }), now),
      null
    );
    assert.equal(
      codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 0 } }), now),
      null
    );
  });
});

describe("retryMetadata", () => {
  it("builds retry headers", () => {
    assert.deepEqual(retryMetadata(0), { retryAfter: null, retryAfterMs: null });
    assert.deepEqual(retryMetadata(-5), { retryAfter: null, retryAfterMs: null });
    assert.deepEqual(retryMetadata(1000), { retryAfter: "1s", retryAfterMs: 1000 });
    assert.deepEqual(retryMetadata(1500), { retryAfter: "2s", retryAfterMs: 1500 });
  });
});

describe("endpointPath", () => {
  it("maps known endpoints", () => {
    assert.equal(endpointPath("chat_completions"), "/v1/chat/completions");
    assert.equal(endpointPath("messages"), "/v1/messages");
    assert.equal(endpointPath("responses"), "/v1/responses");
    assert.equal(endpointPath("custom"), "/custom");
    assert.equal(endpointPath("/leading"), "/leading");
  });
});

describe("prefixWithProvider", () => {
  it("prefixes messages", () => {
    assert.equal(prefixWithProvider("p", "m"), "[p] m");
    assert.equal(prefixWithProvider("", "m"), "m");
    assert.equal(prefixWithProvider("p", ""), "");
  });
});

describe("buildAccountErrorMessage", () => {
  it("summarizes context safely", () => {
    const message = buildAccountErrorMessage("boom", {
      model: "m",
      provider: "p",
      endpoint: "/v1/chat/completions",
      messages: [{ role: "user", content: "hi" }, "raw", [1, 2]],
      parameters: {
        messages: [{ role: "user" }],
        tools: [{ function: { name: "f" } }, { name: "g" }],
        big: "x".repeat(300),
        list: [1, 2, 3],
        nested: { a: 1 },
        nil: null,
      },
    });
    assert.match(message, /Error: boom/);
    assert.match(message, /Provider: p/);
    assert.match(message, /Model: m/);
    assert.match(message, /Messages \(object keys only\)/);
    assert.match(message, /tool\(s\)/);
  });

  it("truncates long error bodies", () => {
    const message = buildAccountErrorMessage("y".repeat(3000), {
      model: "m",
      provider: "",
      endpoint: "",
      messages: [],
      parameters: {},
    });
    assert.match(message, /\[truncated, 3000 chars total\]/);
  });

  it("handles edge provider payloads", () => {
    assert.equal(extractProviderErrorDetail(JSON.stringify("123")), "123");
    assert.equal(isAntigravityResourceExhausted("antigravity", 429, JSON.stringify({ error: 5 })), false);
    assert.equal(codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: 5 }), new Date()), null);
    assert.equal(codexUsageLimitDisabledUntil("codex", 429, JSON.stringify({ error: { type: "usage_limit_reached", resets_at: "10" } }), new Date(0))?.getTime(), 10_000);
    assert.deepEqual(sanitizedProxyError(999, ""), { message: "Provider request failed", type: "api_error" });
  });

  it("summarizes short and odd message inputs", () => {
    const short = buildAccountErrorMessage("boom", { model: "m", provider: "p", endpoint: "e", messages: "nope", parameters: { note: "ok" } });
    assert.match(short, /note/);
    assert.equal(short.includes("Messages"), false);

    const odd = buildAccountErrorMessage("boom", { model: "m", provider: "p", endpoint: "e", messages: [() => undefined], parameters: {} });
    assert.match(odd, /object/);
  });

  it("builds account errors with edge inputs", () => {
    const many = Array.from({ length: 35 }, (_, i) => ({ index: i }));
    const message = buildAccountErrorMessage("x".repeat(200), {
      model: "m",
      provider: "",
      endpoint: "",
      messages: many,
      parameters: { tools: Array.from({ length: 15 }, (_, i) => ({ name: `t${i}` })), list: Array.from({ length: 15 }, (_, i) => i), s: "y".repeat(300) },
    });
    assert.match(message, /tool\(s\)/);
    assert.match(message, /truncated, 15 items total/);
    assert.match(message, /truncated_5_more_items/);

    const unserializable = buildAccountErrorMessage("boom", { model: "m", provider: "p", endpoint: "e", messages: [{ a: 1 }, [1], "s", true, 2, null], parameters: { big: 10n } });
    assert.match(unserializable, /unserializable parameters/);
    assert.match(unserializable, /Messages \(object keys only\)/);
  });
});
