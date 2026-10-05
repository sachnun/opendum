import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyThinkingConfig,
  boolValue,
  configBool,
  configIntMap,
  configString,
  configStringMap,
  configValue,
  defaultThinkingBudget,
  fallbackAntigravitySystemInstructionModel,
  geminiThinkingLevelFromModel,
  isGemini3ModelName,
  isPaidGoogleTierId,
  isTieredGemini3Model,
  lastModelSegment,
  normalizeBodyForModel,
  normalizeGoogleTierId,
  normalizeThinkingConfig,
  numberAsFloat,
  requestedGemini3ThinkingLevel,
  resolveAntigravityGemini3ModelVariant,
  resolveModel,
  shouldSetAnthropicBeta,
  signatureCacheKey,
  signatureFamily,
  thinkingLevelFromBudget,
  thinkingLevelFromEffort,
  trimGeminiThinkingLevelSuffix,
} from "#providers/providers/antigravity/model-config.ts";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  SIGNATURE_CACHE_PREFIX,
  type AntigravityRuntime,
} from "#providers/providers/antigravity/runtime.ts";

type Json = Record<string, unknown>;

function runtime(configs: Record<string, Json> = {}): AntigravityRuntime {
  return {
    name: "antigravity",
    registry: {
      providerModelConfig: (model: string) => configs[model] ?? null,
      upstreamModelName: (model: string) => `up:${model}`,
    },
  } as unknown as AntigravityRuntime;
}

describe("antigravity model name helpers", () => {
  it("splits model segments", () => {
    assert.equal(lastModelSegment("a/b/c"), "c");
  });

  it("identifies gemini 3 variants", () => {
    assert.equal(isGemini3ModelName("gemini-3-pro"), true);
    assert.equal(isGemini3ModelName("x/gemini-3.5-flash"), true);
    assert.equal(isGemini3ModelName("gemini-2-flash"), false);
    assert.equal(isTieredGemini3Model("gemini-3-flash-tiered"), true);
    assert.equal(isTieredGemini3Model("gemini-3-flash"), false);
  });

  it("reads thinking level suffixes", () => {
    assert.equal(geminiThinkingLevelFromModel("gemini-3-flash-high"), "high");
    assert.equal(geminiThinkingLevelFromModel("gemini-3-flash"), "");
    assert.equal(trimGeminiThinkingLevelSuffix("gemini-3-flash-high"), "gemini-3-flash");
    assert.equal(trimGeminiThinkingLevelSuffix("plain"), "plain");
  });

  it("normalizes tiers", () => {
    assert.equal(normalizeGoogleTierId("  Paid "), "paid");
    assert.equal(isPaidGoogleTierId("standard-tier"), true);
    assert.equal(isPaidGoogleTierId("free-tier"), false);
  });

  it("defaults thinking budgets by effort", () => {
    assert.equal(defaultThinkingBudget("low"), 1024);
    assert.equal(defaultThinkingBudget("medium"), 10000);
    assert.equal(defaultThinkingBudget("xhigh"), 32000);
    assert.equal(defaultThinkingBudget("other"), 0);
  });

  it("decides system instruction fallback", () => {
    assert.equal(fallbackAntigravitySystemInstructionModel("claude-sonnet"), true);
    assert.equal(fallbackAntigravitySystemInstructionModel("gemini-3-flash"), true);
    assert.equal(fallbackAntigravitySystemInstructionModel("gemini-2-flash"), false);
    assert.equal(fallbackAntigravitySystemInstructionModel("gemini-3-image"), false);
    assert.equal(fallbackAntigravitySystemInstructionModel("claude-image"), false);
  });

  it("handles primitive helpers", () => {
    assert.equal(boolValue(true, false), true);
    assert.equal(boolValue("x", false), false);
    assert.equal(numberAsFloat(3.5), 3.5);
    assert.equal(numberAsFloat("3"), null);
    assert.equal(numberAsFloat(Number.NaN), null);
  });
});

describe("configValue", () => {
  it("reads registry and custom config", () => {
    assert.equal(configValue(runtime({ m: { flag: true } }), "m", "flag"), true);
    assert.equal(configValue(runtime({ m: { custom: { flag: true } } }), "m", "flag"), true);
    assert.equal(configValue(runtime(), "m", "flag"), undefined);
  });

  it("derives gemini and claude defaults", () => {
    const rt = runtime();
    assert.equal(configValue(rt, "gemini-3-flash", "inject_thought_signature"), true);
    assert.equal(configValue(rt, "gemini-3-flash", "signature_family"), "gemini-flash");
    assert.equal(configValue(rt, "gemini-3-flash", "system_instruction"), true);
    assert.equal(configValue(rt, "gemini-3-flash", "thinking_format"), "level");
    assert.deepEqual(configValue(rt, "gemini-3-flash", "thinking_levels"), {
      high: "high",
      low: "low",
      medium: "medium",
      none: "minimal",
      xhigh: "high",
    });
    assert.equal(configValue(rt, "gemini-2-pro", "thinking_format"), "budget");
    assert.deepEqual(configValue(rt, "gemini-2-pro", "thinking_budgets"), { high: 32768, low: 8192, medium: 16384, xhigh: 32768 });
    assert.equal(configValue(rt, "gemini-3-image", "thinking_format"), undefined);
    assert.equal(configValue(rt, "gemini-3-flash-high", "thinking_format"), "level");
    assert.equal(configValue(rt, "claude-sonnet", "anthropic_beta"), true);
    assert.equal(configValue(rt, "claude-sonnet", "signature_family"), "claude");
    assert.equal(configValue(rt, "other", "anything"), undefined);
  });

  it("reads typed config values", () => {
    const rt = runtime({ m: { flag: true, name: "  x  ", levels: { a: "x", b: 2, c: "  " }, budgets: { a: 5, b: "6", c: 0, d: 2.9 } } });
    assert.equal(configBool(rt, "m", "flag"), true);
    assert.equal(configString(rt, "m", "name"), "x");
    assert.deepEqual(configStringMap(rt, "m", "levels"), { a: "x" });
    assert.deepEqual(configIntMap(rt, "m", "budgets"), { a: 5, b: 6, d: 2 });
    assert.deepEqual(configStringMap(rt, "m", "missing"), {});
    assert.deepEqual(configIntMap(rt, "m", "missing"), {});
  });
});

describe("request shaping", () => {
  it("resolves upstream model names", () => {
    assert.equal(resolveModel(runtime(), "kiro/claude"), "up:claude");
    assert.equal(resolveModel(runtime(), "kiro/claude:thinking"), "up:claude");
  });

  it("normalizes bodies for top_p constraints", () => {
    const rt = runtime({ m: { top_p_min_095: true } });
    assert.deepEqual(normalizeBodyForModel(rt, { top_p: 0.5, logit_bias: {}, a: 1 }, "m"), { a: 1 });
    assert.deepEqual(normalizeBodyForModel(rt, { top_p: 0.99, a: 1 }, "m"), { top_p: 0.99, a: 1 });
  });

  it("decides anthropic beta headers", () => {
    assert.equal(shouldSetAnthropicBeta(runtime({ m: { anthropic_beta: true } }), "m"), true);
    assert.equal(shouldSetAnthropicBeta(runtime(), "claude-thinking"), true);
    assert.equal(shouldSetAnthropicBeta(runtime(), "claude"), false);
  });

  it("computes signature family and cache keys", () => {
    assert.equal(signatureFamily(runtime({ m: { transform: "t" } }), "m"), "t");
    assert.equal(signatureFamily(runtime(), "claude-sonnet"), "claude");
    assert.match(signatureCacheKey(runtime(), "claude-sonnet", "s", "  text  "), new RegExp(`^${SIGNATURE_CACHE_PREFIX}:`));
  });
});

describe("thinking levels", () => {
  it("maps budgets to levels", () => {
    assert.equal(thinkingLevelFromBudget(runtime(), "gemini-3-flash", 5000), "low");
    assert.equal(thinkingLevelFromBudget(runtime(), "gemini-3-flash", 10000), "medium");
    assert.equal(thinkingLevelFromBudget(runtime(), "gemini-3-flash", 30000), "high");
    assert.equal(thinkingLevelFromBudget(runtime(), "gemini-3-pro", 10000), "high");
    assert.equal(thinkingLevelFromBudget(runtime(), "other", 5000), "low");
    assert.equal(thinkingLevelFromBudget(runtime(), "other", 10000), "medium");
    assert.equal(thinkingLevelFromBudget(runtime(), "other", 20000), "high");
  });

  it("maps efforts to levels", () => {
    assert.equal(thinkingLevelFromEffort(runtime(), "gemini-3-flash", "high"), "high");
    assert.equal(thinkingLevelFromEffort(runtime(), "gemini-3-flash", "xhigh"), "high");
  });

  it("reads requested levels from the body", () => {
    const rt = runtime();
    assert.equal(requestedGemini3ThinkingLevel(rt, "gemini-3-flash", { thinking: { thinkingLevel: "low" } }), "low");
    assert.equal(requestedGemini3ThinkingLevel(rt, "gemini-3-flash", { thinking: { budget_tokens: 5000 } }), "low");
    assert.equal(requestedGemini3ThinkingLevel(rt, "gemini-3-flash", { thinking_budget: 5000 }), "low");
    assert.equal(requestedGemini3ThinkingLevel(rt, "gemini-3-flash", { reasoning_effort: "high" }), "high");
    assert.equal(requestedGemini3ThinkingLevel(rt, "gemini-3-flash", { reasoning: { effort: "low" } }), "low");
    assert.equal(requestedGemini3ThinkingLevel(rt, "gemini-3-flash", {}), "");
  });

  it("resolves gemini 3 model variants", () => {
    const rt = runtime();
    assert.equal(resolveAntigravityGemini3ModelVariant(rt, "gemini-2-flash", {}), "gemini-2-flash");
    assert.equal(resolveAntigravityGemini3ModelVariant(rt, "gemini-3.5-flash", {}), "gemini-3.5-flash-medium");
    assert.equal(resolveAntigravityGemini3ModelVariant(rt, "gemini-3.5-flash-lite", {}), "gemini-3.5-flash-lite");
    assert.equal(resolveAntigravityGemini3ModelVariant(rt, "gemini-3-pro", {}), "gemini-3-pro-high");
    assert.equal(resolveAntigravityGemini3ModelVariant(rt, "gemini-3-pro-high", {}), "gemini-3-pro-high");
  });
});

describe("applyThinkingConfig", () => {
  it("applies budget format for non gemini 3 models", () => {
    const payload: Json = {};
    applyThinkingConfig(runtime(), payload, "claude-sonnet", "", 5000);
    assert.deepEqual(payload.generationConfig, { thinkingConfig: { thinkingBudget: 5000, includeThoughts: true } });
  });

  it("applies levels for gemini 3 models", () => {
    const withBudget: Json = {};
    applyThinkingConfig(runtime(), withBudget, "gemini-3-flash", "", 5000);
    assert.deepEqual(withBudget.generationConfig, { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } });

    const withEffort: Json = {};
    applyThinkingConfig(runtime(), withEffort, "gemini-3-flash", "high", 0);
    assert.deepEqual(withEffort.generationConfig, { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });
  });

  it("ignores none effort", () => {
    const payload: Json = {};
    applyThinkingConfig(runtime(), payload, "gemini-3-flash", "none", 0);
    assert.equal("generationConfig" in payload, false);
  });

  it("supports level-format configs and effort budgets", () => {
    const levelRt = runtime({ m: { thinking_format: "level", thinking_levels: { high: "high" } } });
    const levelPayload: Json = {};
    applyThinkingConfig(levelRt, levelPayload, "m", "high", 0);
    assert.deepEqual(levelPayload.generationConfig, { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } });

    const budgetRt = runtime({ m: { thinking_budgets: { low: 1024, high: 5000 } } });
    const lowPayload: Json = {};
    applyThinkingConfig(budgetRt, lowPayload, "m", "low", 0);
    assert.equal((lowPayload.generationConfig as Json).thinkingConfig instanceof Object, true);
    assert.deepEqual((lowPayload.generationConfig as Json).thinkingConfig, { thinkingBudget: 1024, includeThoughts: true });

    const fallbackPayload: Json = {};
    applyThinkingConfig(budgetRt, fallbackPayload, "m", "medium", 0);
    assert.deepEqual((fallbackPayload.generationConfig as Json).thinkingConfig, { thinkingBudget: 5000, includeThoughts: true });
  });
});

describe("normalizeThinkingConfig", () => {
  it("normalizes gemini 3 thinking configs", () => {
    const payload: Json = { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" }, maxOutputTokens: 100000 } };
    normalizeThinkingConfig(runtime(), payload, "gemini-3-flash");
    assert.equal(((payload.generationConfig as Json).thinkingConfig as Json).thinkingLevel, "low");
  });

  it("drops unusable gemini 3 levels", () => {
    const payload: Json = { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" }, maxOutputTokens: 5000 } };
    normalizeThinkingConfig(runtime(), payload, "gemini-3-pro");
    assert.equal("thinkingConfig" in (payload.generationConfig as Json), false);
  });

  it("creates generation config for gemini 3 models", () => {
    const payload: Json = {};
    normalizeThinkingConfig(runtime(), payload, "gemini-3-flash");
    assert.deepEqual(payload.generationConfig, {});
  });

  it("handles thinking models without thinking config", () => {
    const payload: Json = {};
    normalizeThinkingConfig(runtime({ m: { thinking_model: true } }), payload, "m");
    assert.deepEqual((payload.generationConfig as Json).maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("adjusts max output tokens for thinking models", () => {
    const payload: Json = { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 5000 } } };
    normalizeThinkingConfig(runtime({ m: { thinking_model: true } }), payload, "m");
    const generation = payload.generationConfig as Json;
    assert.equal(generation.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS + 5000);
    assert.deepEqual(generation.thinkingConfig, { thinkingBudget: 5000, include_thoughts: true });
  });

  it("passes through plain thinking maps", () => {
    const payload: Json = { generationConfig: { thinkingConfig: { thinkingBudget: 5000 } } };
    normalizeThinkingConfig(runtime(), payload, "other");
    assert.deepEqual((payload.generationConfig as Json).thinkingConfig, { thinkingBudget: 5000 });
  });

  it("deletes empty thinking configs", () => {
    const payload: Json = { generationConfig: { thinkingConfig: {} } };
    normalizeThinkingConfig(runtime(), payload, "claude-sonnet");
    assert.equal("thinkingConfig" in (payload.generationConfig as Json), false);
  });

  it("ignores unrelated models", () => {
    const payload: Json = {};
    normalizeThinkingConfig(runtime(), payload, "plain");
    assert.equal("generationConfig" in payload, false);
  });
});
