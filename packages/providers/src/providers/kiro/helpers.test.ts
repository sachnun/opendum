import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import {
  defaultAny,
  defaultThinkingBudget,
  estimateKiroTokens,
  firstKiroNumber,
  joinNonEmpty,
  kiroApiUrlForAccount,
  kiroContextWindowSize,
  kiroErrorMessage,
  kiroNumberAsFloat,
  kiroReasoningContent,
  kiroRegionFromArn,
  kiroTruncate,
  kiroUsage,
  kiroUsageFromContext,
  lastModelSegment,
  normalizeKiroModel,
  normalizeKiroTier,
} from "#providers/providers/kiro/helpers.ts";

describe("basic kiro helpers", () => {
  it("takes the last model segment", () => {
    assert.equal(lastModelSegment("vendor/model"), "model");
    assert.equal(lastModelSegment("model"), "model");
    assert.equal(lastModelSegment("a/b/c"), "c");
  });

  it("defaults nullish values", () => {
    assert.equal(defaultAny(1, 2), 1);
    assert.equal(defaultAny(null, 2), 2);
    assert.equal(defaultAny(undefined, 2), 2);
    assert.equal(defaultAny(0, 2), 0);
  });

  it("maps reasoning effort to a thinking budget", () => {
    assert.equal(defaultThinkingBudget("low"), 1024);
    assert.equal(defaultThinkingBudget("medium"), 10000);
    assert.equal(defaultThinkingBudget("high"), 32000);
    assert.equal(defaultThinkingBudget("xhigh"), 32000);
    assert.equal(defaultThinkingBudget("none"), 0);
  });

  it("joins non-empty values", () => {
    assert.equal(joinNonEmpty("-", "a", "", " b ", "c"), "a- b -c");
    assert.equal(joinNonEmpty("-", "", "  "), "");
  });

  it("truncates safely", () => {
    assert.equal(kiroTruncate("abcdef", 3), "abc");
    assert.equal(kiroTruncate("abc", 10), "abc");
    assert.equal(kiroTruncate("abc", 0), "abc");
    assert.equal(kiroTruncate("abc", -1), "abc");
  });
});

describe("normalizeKiroTier", () => {
  it("maps known raw types", () => {
    assert.equal(normalizeKiroTier("Q_DEVELOPER_STANDALONE_FREE", ""), "free");
    assert.equal(normalizeKiroTier("q_developer_standalone_power", ""), "power");
    assert.equal(normalizeKiroTier("Q_DEVELOPER_STANDALONE_PRO", ""), "pro");
    assert.equal(normalizeKiroTier("Q_DEVELOPER_STANDALONE_PRO_PLUS", ""), "pro-plus");
    assert.equal(normalizeKiroTier("Q_DEVELOPER_STANDALONE", ""), "standalone");
  });

  it("falls back to the subscription title", () => {
    assert.equal(normalizeKiroTier("unknown", "Kiro Pro+"), "pro-plus");
    assert.equal(normalizeKiroTier("unknown", "Power plan"), "power");
    assert.equal(normalizeKiroTier("unknown", "Pro plan"), "pro");
    assert.equal(normalizeKiroTier("unknown", "Free tier"), "free");
    assert.equal(normalizeKiroTier("unknown", ""), "");
    assert.equal(normalizeKiroTier("unknown", "Business_Team"), "business-team");
  });
});

describe("region and url helpers", () => {
  it("extracts a region from an arn", () => {
    assert.equal(kiroRegionFromArn("arn:aws:sso:us-west-2:123:foo"), "us-west-2");
    assert.equal(kiroRegionFromArn("not-an-arn"), "");
    assert.equal(kiroRegionFromArn("arn:aws:sso:::123:foo"), "");
  });

  it("builds the api url with the account region", () => {
    assert.equal(kiroApiUrlForAccount({ id: "a", userId: "u", provider: "kiro" }), "https://q.us-east-1.amazonaws.com/generateAssistantResponse");
    assert.equal(
      kiroApiUrlForAccount({ id: "a", userId: "u", provider: "kiro", accountId: "arn:aws:sso:eu-west-1:1:x" }),
      "https://q.eu-west-1.amazonaws.com/generateAssistantResponse"
    );
  });
});

describe("kiro number helpers", () => {
  it("parses floats", () => {
    assert.equal(kiroNumberAsFloat(1.5), 1.5);
    assert.equal(kiroNumberAsFloat("2.5"), 2.5);
    assert.equal(kiroNumberAsFloat("abc"), 0);
    assert.equal(kiroNumberAsFloat(null), 0);
  });

  it("reports the context window size", () => {
    assert.equal(kiroContextWindowSize("claude-1m"), 1_000_000);
    assert.equal(kiroContextWindowSize("claude"), 200_000);
  });

  it("estimates tokens", () => {
    assert.equal(estimateKiroTokens(""), 0);
    assert.equal(estimateKiroTokens("abcd"), 1);
    assert.equal(estimateKiroTokens("abcde"), 2);
  });

  it("builds usage from context percentage", () => {
    assert.deepEqual(kiroUsageFromContext("claude-1m", 50, "abcd"), {
      prompt_tokens: 499999,
      completion_tokens: 1,
      total_tokens: 500000,
    });
    assert.deepEqual(kiroUsageFromContext("claude", 0, "abcd"), {
      prompt_tokens: 0,
      completion_tokens: 1,
      total_tokens: 1,
    });
  });

  it("returns the first positive number", () => {
    assert.equal(firstKiroNumber({ a: 0, b: "5" }, ["a", "b"]), 5);
    assert.equal(firstKiroNumber({}, ["a"]), 0);
  });
});

describe("kiro reasoning and usage extraction", () => {
  it("reads reasoning text", () => {
    assert.equal(kiroReasoningContent({ reasoningContentEvent: { text: "why" } }), "why");
    assert.equal(kiroReasoningContent({ reasoningContentEvent: { reasoning_content: "alt" } }), "alt");
    assert.equal(kiroReasoningContent({ text: "signed", signature: "s" }), "signed");
    assert.equal(kiroReasoningContent({ text: "typed", type: "reasoningContentEvent" }), "typed");
    assert.equal(kiroReasoningContent({ text: "plain" }), "");
    assert.equal(kiroReasoningContent({}), "");
  });

  it("extracts usage objects", () => {
    assert.deepEqual(kiroUsage({ usage: { inputTokens: 10, outputTokens: 5 } }), {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    assert.deepEqual(kiroUsage({ tokenUsage: { promptTokens: "3", completionTokens: 2 } }), {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    assert.deepEqual(kiroUsage({ type: "tokenUsage", inputTokens: 1, outputTokens: 1 }), {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    });
    assert.equal(kiroUsage({ usage: {} }), null);
    assert.equal(kiroUsage({}), null);
  });

  it("extracts error messages", () => {
    assert.equal(kiroErrorMessage({ message: "m", error: "e" }), "m");
    assert.equal(kiroErrorMessage({ message: "m", Error: "E" }), "m");
    assert.equal(kiroErrorMessage({ error: "e" }), "e");
    assert.equal(kiroErrorMessage({ Error: "E" }), "E");
    assert.equal(kiroErrorMessage({}), "");
  });
});

describe("normalizeKiroModel", () => {
  function registry(supported: string[]): Registry {
    const set = new Set(supported);
    return {
      isSupportedByProvider: (model: string) => set.has(model),
      upstreamModelName: (model: string) => `up-${model}`,
    } as unknown as Registry;
  }

  it("resolves a supported model", () => {
    assert.equal(normalizeKiroModel(registry(["claude-sonnet"]), "kiro/claude-sonnet"), "up-claude-sonnet");
  });

  it("strips a -thinking suffix when the base is supported", () => {
    assert.equal(normalizeKiroModel(registry(["claude-sonnet"]), "claude-sonnet-thinking"), "up-claude-sonnet");
  });

  it("falls back to the upstream name for unsupported models", () => {
    assert.equal(normalizeKiroModel(registry([]), "mystery"), "up-mystery");
  });
});
