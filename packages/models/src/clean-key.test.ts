import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stripParamInfoKey,
  extractDescriptors,
  aliasesFromUpstream,
  largestSizeValue,
  PARAMETER_INFO_PATTERNS,
} from "./clean-key.ts";

test("stripParamInfoKey preserves empty input", () => {
  assert.equal(stripParamInfoKey(""), "");
  assert.equal(stripParamInfoKey(null), null);
  assert.equal(stripParamInfoKey(undefined), undefined);
});

test("stripParamInfoKey strips MoE compound active suffix", () => {
  assert.equal(stripParamInfoKey("mock3-235b-a22b"), "mock3");
  assert.equal(stripParamInfoKey("mock-8x7b-v0.1"), "mock-8x7b-v0.1");
});

test("stripParamInfoKey strips MoE expert-count suffix when paired with size", () => {
  assert.equal(stripParamInfoKey("mock-4-maverick-17b-128e-instruct"), "mock-4-maverick");
  assert.equal(stripParamInfoKey("mock-4-scout-17b-16e-instruct"), "mock-4-scout");
});

test("stripParamInfoKey strips standalone size tokens (B/M)", () => {
  assert.equal(stripParamInfoKey("mock-3-27b"), "mock-3");
  assert.equal(stripParamInfoKey("mock-3.1-70b"), "mock-3.1");
  assert.equal(stripParamInfoKey("mockmodel-7b-instruct"), "mockmodel");
  assert.equal(stripParamInfoKey("mock-3-medium"), "mock-3-medium");
});

test("stripParamInfoKey strips standalone size tokens (T)", () => {
  assert.equal(stripParamInfoKey("mock-176t"), "mock");
});

test("stripParamInfoKey strips quantization suffixes", () => {
  assert.equal(stripParamInfoKey("mock3-30b-a3b-fp8"), "mock3");
  assert.equal(stripParamInfoKey("mock-3.1-8b-instruct-fp8"), "mock-3.1");
  assert.equal(stripParamInfoKey("model-awq"), "model");
  assert.equal(stripParamInfoKey("model-gptq"), "model");
  assert.equal(stripParamInfoKey("model-gguf"), "model");
  assert.equal(stripParamInfoKey("model-q4"), "model");
});

test("stripParamInfoKey strips behavior descriptors at trailing pass + forward pass", () => {
  assert.equal(stripParamInfoKey("mock-opus-4-6-thinking"), "mock-opus-4-6");
  assert.equal(stripParamInfoKey("mock-large-3-675b-instruct-2512"), "mock-large-3");
  assert.equal(stripParamInfoKey("mock-large-3-instruct"), "mock-large-3");
  assert.equal(stripParamInfoKey("model-preview-thinking"), "model");
  assert.equal(stripParamInfoKey("model-experimental"), "model");
  assert.equal(stripParamInfoKey("model-exp"), "model");
  assert.equal(stripParamInfoKey("model-deprecated"), "model");
});

test("stripParamInfoKey strips date suffixes but not release versions", () => {
  assert.equal(stripParamInfoKey("mock-large-3-675b-instruct-2512"), "mock-large-3");
  assert.equal(stripParamInfoKey("mock-small-3.1-24b-instruct-2503"), "mock-small-3.1");
  assert.equal(stripParamInfoKey("model-2024"), "model-2024");
  assert.equal(stripParamInfoKey("mock-v0.1"), "mock-v0.1");
  assert.equal(stripParamInfoKey("mock-v0.3"), "mock-v0.3");
  assert.equal(stripParamInfoKey("mock-8x7b-v0.1"), "mock-8x7b-v0.1");
  assert.equal(stripParamInfoKey("mock-nano-9b-v2"), "mock-nano-v2");
  assert.equal(stripParamInfoKey("mock-nano-v2"), "mock-nano-v2");
  assert.equal(stripParamInfoKey("mock-v2.5"), "mock-v2.5");
  assert.equal(stripParamInfoKey("mock-v2-flash"), "mock-v2-flash");
});

test("stripParamInfoKey strips embedded dates inside descriptor chain", () => {
  assert.equal(stripParamInfoKey("mock3-235b-a22b-thinking-2507"), "mock3");
});

test("stripParamInfoKey strips MMDD date suffixes", () => {
  assert.equal(stripParamInfoKey("mock-v4-flash-0731"), "mock-v4-flash");
  assert.equal(stripParamInfoKey("mock-v4-pro-0813"), "mock-v4-pro");
  assert.equal(stripParamInfoKey("mock-v4-flash-0801"), "mock-v4-flash");
  assert.equal(stripParamInfoKey("mock-chat-v3-0324"), "mock-v3");
  assert.equal(stripParamInfoKey("mock-3.5-turbo-0613"), "mock-3.5-turbo");
});

test("stripParamInfoKey strips YYMMDD date suffixes", () => {
  assert.equal(stripParamInfoKey("mock3-250731"), "mock3");
  assert.equal(stripParamInfoKey("mock-v4-flash-260215"), "mock-v4-flash");
});

test("stripParamInfoKey keeps date tokens when keepDates is set", () => {
  assert.equal(stripParamInfoKey("mock-v4-flash-0731", { keepDates: true }), "mock-v4-flash-0731");
  assert.equal(stripParamInfoKey("mock-large-3-675b-instruct-2512", { keepDates: true }), "mock-large-3-2512");
});

test("stripParamInfoKey rejects 4-6 digit dates with month > 12", () => {
  assert.equal(stripParamInfoKey("model-1234"), "model-1234");
  assert.equal(stripParamInfoKey("model-2024"), "model-2024");
});

test("stripParamInfoKey preserves identifier tokens (families, tiers, modalities)", () => {
  assert.equal(stripParamInfoKey("mock-opus-4-6"), "mock-opus-4-6");
  assert.equal(stripParamInfoKey("mock-2-flash"), "mock-2-flash");
  assert.equal(stripParamInfoKey("mock3-coder"), "mock3-coder");
  assert.equal(stripParamInfoKey("mock-3-ultra"), "mock-3-ultra");
  assert.equal(stripParamInfoKey("mock-medium"), "mock-medium");
});

test("stripParamInfoKey preserves tier words", () => {
  assert.equal(stripParamInfoKey("model-ultra"), "model-ultra");
  assert.equal(stripParamInfoKey("model-super"), "model-super");
  assert.equal(stripParamInfoKey("model-pro"), "model-pro");
  assert.equal(stripParamInfoKey("model-plus"), "model-plus");
  assert.equal(stripParamInfoKey("model-nano"), "model-nano");
  assert.equal(stripParamInfoKey("model-mini"), "model-mini");
  assert.equal(stripParamInfoKey("model-flash"), "model-flash");
  assert.equal(stripParamInfoKey("model-lite"), "model-lite");
  assert.equal(stripParamInfoKey("model-premium"), "model-premium");
});

test("stripParamInfoKey preserves modality descriptors", () => {
  assert.equal(stripParamInfoKey("mock3-coder"), "mock3-coder");
  assert.equal(stripParamInfoKey("mock3-vl"), "mock3-vl");
  assert.equal(stripParamInfoKey("mock-3.2-vision-instruct"), "mock-3.2-vision");
  assert.equal(stripParamInfoKey("mock-nano-vl"), "mock-nano-vl");
});

test("stripParamInfoKey keeps trailing free token (caller is responsible for :free suffix)", () => {
  assert.equal(stripParamInfoKey("mock3-coder-free"), "mock3-coder-free");
  assert.equal(stripParamInfoKey("mock-3.2-free"), "mock-3.2-free");
  assert.equal(stripParamInfoKey("mock-oss-free"), "mock-oss-free");
});

test("stripParamInfoKey handles underscore separators", () => {
  assert.equal(stripParamInfoKey("mock3_coder_30b_a3b_instruct"), "mock3-coder");
  assert.equal(stripParamInfoKey("mock_3_70b_instruct"), "mock-3");
});

test("stripParamInfoKey falls back to input when nothing remains", () => {
  assert.equal(stripParamInfoKey(""), "");
  assert.equal(stripParamInfoKey("free"), "free");
  assert.equal(stripParamInfoKey("12345"), "12345");
});

test("extractDescriptors extracts meta updates", () => {
  assert.deepEqual(extractDescriptors("mock-opus-4-6-thinking"), { reasoning: true });
  assert.deepEqual(extractDescriptors("mock3-vl-30b-a3b-thinking"), { reasoning: true });
  assert.deepEqual(extractDescriptors("mock3-coder-30b-a3b-instruct"), {});
  assert.deepEqual(extractDescriptors("mock-large-3-exp"), {});
  assert.deepEqual(extractDescriptors("mock-2-flash-preview"), {});
  assert.deepEqual(extractDescriptors("mock-large-3-instruct"), {});
});

test("extractDescriptors returns empty object when input empty", () => {
  assert.deepEqual(extractDescriptors(""), {});
  assert.deepEqual(extractDescriptors(null), {});
});

test("aliasesFromUpstream generates kebab fallback for upstream IDs", () => {
  assert.deepEqual(aliasesFromUpstream(["vendor/mock-model", "Vendor/Mock2-32B"]), [
    "vendor-mock-model",
    "vendor/mock-model",
    "Vendor-Mock2-32B",
    "Vendor/Mock2-32B",
  ]);
});

test("aliasesFromUpstream handles empty/null input", () => {
  assert.deepEqual(aliasesFromUpstream(), []);
  assert.deepEqual(aliasesFromUpstream([]), []);
  assert.deepEqual(aliasesFromUpstream([""]), []);
  assert.deepEqual(aliasesFromUpstream(["non/slash", "/", "with-only-content"]), [
    "non-slash",
    "non/slash",
    "-",
    "/",
    "with-only-content",
  ]);
});

test("aliasesFromUpstream preserves single-name upstream without slash", () => {
  assert.deepEqual(aliasesFromUpstream(["free-model"]), ["free-model"]);
  assert.deepEqual(aliasesFromUpstream(["vendor/model", "plain"]), [
    "vendor-model",
    "vendor/model",
    "plain",
  ]);
});

test("largestSizeValue finds dominant size magnitude", () => {
  assert.equal(largestSizeValue(""), 0);
  assert.equal(largestSizeValue("mock-3.3-70b-instruct"), 70);
  assert.equal(largestSizeValue("mock3-235b-a22b"), 235);
  assert.equal(largestSizeValue("mock3-coder-480b-a35b-instruct"), 480);
  assert.equal(largestSizeValue("no-size-here"), 0);
});

test("largestSizeValue handles t-scale and decimal sizes", () => {
  assert.equal(largestSizeValue("mock-176t"), 0);
  assert.equal(largestSizeValue("mock-176b"), 176);
  assert.equal(largestSizeValue("model-1.5b"), 1.5);
});

test("PARAMETER_INFO_PATTERNS exposes regex constants", () => {
  assert.ok(PARAMETER_INFO_PATTERNS.ACTIVE_PARAMS_SUFFIX instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.EXPERT_COUNT_SUFFIX instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.SIZE_BM instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.SIZE_T instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.QUANTIZATION instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.VERSION instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.BEHAVIOR_DESCRIPTOR instanceof RegExp);
  assert.ok(PARAMETER_INFO_PATTERNS.MODALITY_DESCRIPTOR instanceof RegExp);
});

test("toModelKey helper (openrouter.mjs) correctly trims trailing -free", () => {
  function toModelKey(modelId: string) {
    const normalizedModelId = modelId.replace(/^library\//, "");
    const providerStrippedModelId =
      normalizedModelId === "openrouter/free"
        ? normalizedModelId
        : normalizedModelId.includes("/")
          ? normalizedModelId.slice(normalizedModelId.indexOf("/") + 1)
          : normalizedModelId;

    const modelKey = providerStrippedModelId
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-");

    const cleaned = stripParamInfoKey(modelKey);
    if (modelKey !== "openrouter-free" && cleaned.endsWith("-free")) {
      return cleaned.slice(0, -"-free".length);
    }

    return cleaned;
  }

  assert.equal(toModelKey("vendor/mock3-coder:free"), "mock3-coder");
  assert.equal(toModelKey("vendor/mock3-next-80b-a3b-instruct:free"), "mock3-next");
  assert.equal(toModelKey("vendor/mock-4-26b-a4b-it:free"), "mock-4");
  assert.equal(toModelKey("vendor/mock-4-31b-it:free"), "mock-4");
  assert.equal(toModelKey("vendor/mock-oss-120b:free"), "mock-oss");
  assert.equal(toModelKey("vendor/mock-oss-20b:free"), "mock-oss");
  assert.equal(toModelKey("vendor/mock-3.2-3b-instruct:free"), "mock-3.2");
  assert.equal(toModelKey("vendor/mock-3.3-70b-instruct:free"), "mock-3.3");
  assert.equal(toModelKey("vendor/mock-n2-pro:free"), "mock-n2-pro");
  assert.equal(toModelKey("vendor/mock-2.5-1.2b-instruct:free"), "mock-2.5");
  assert.equal(toModelKey("vendor/mock-2.5-1.2b-thinking:free"), "mock-2.5");
  assert.equal(toModelKey("vendor/mock-3-other-3.1-405b:free"), "mock-3-other-3.1");
  assert.equal(toModelKey("vendor/mock-24b-venice-edition:free"), "mock-venice-edition");
  assert.equal(toModelKey("vendor/mock-mini-code:free"), "mock-mini-code");
  assert.equal(toModelKey("vendor/mock-3-nano-30b-a3b:free"), "mock-3-nano");
  assert.equal(toModelKey("vendor/mock-oss-120b"), "mock-oss");
  assert.equal(toModelKey("vendor/mock3-coder-480b-a35b-instruct:free"), "mock3-coder");
  assert.equal(toModelKey("vendor/mock3-vl-235b-a22b-thinking"), "mock3-vl");
  assert.equal(toModelKey("vendor/mock3-235b-a22b-thinking-2507"), "mock3");
});

test("toModelKey regression: positive slice would have collapsed keys (must NOT happen)", () => {
  function buggyTrim(cleaned: string) {
    return cleaned.slice(0, "-free".length);
  }

  const cleaned = stripParamInfoKey("mock3-next-80b-a3b-instruct-free");
  assert.equal(
    buggyTrim(cleaned),
    "mock3",
    "positive slice collapse was the historical bug shape",
  );
  assert.equal(
    cleaned.slice(0, -"-free".length),
    "mock3-next",
    "correct trim keeps family identifier",
  );
});

test("toModelKey preserves openrouter/free special-case", () => {
  function toModelKey(modelId: string) {
    const normalizedModelId = modelId.replace(/^library\//, "");
    const providerStrippedModelId =
      normalizedModelId === "openrouter/free"
        ? normalizedModelId
        : normalizedModelId.includes("/")
          ? normalizedModelId.slice(normalizedModelId.indexOf("/") + 1)
          : normalizedModelId;

    const modelKey = providerStrippedModelId
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-");

    const cleaned = stripParamInfoKey(modelKey);
    if (modelKey !== "openrouter-free" && cleaned.endsWith("-free")) {
      return cleaned.slice(0, -"-free".length);
    }

    return cleaned;
  }

  assert.equal(toModelKey("openrouter/free"), "openrouter-free");
});
