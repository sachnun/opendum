import { test } from "node:test";
import assert from "node:assert/strict";

import {
  stripParamInfoKey,
  extractDescriptors,
  aliasesFromUpstream,
  largestSizeValue,
  PARAMETER_INFO_PATTERNS,
} from "./clean-key.mjs";

test("stripParamInfoKey preserves empty input", () => {
  assert.equal(stripParamInfoKey(""), "");
  assert.equal(stripParamInfoKey(null), null);
  assert.equal(stripParamInfoKey(undefined), undefined);
});

test("stripParamInfoKey strips MoE compound active suffix", () => {
  assert.equal(stripParamInfoKey("qwen3-235b-a22b"), "qwen3");
  assert.equal(stripParamInfoKey("mixtral-8x7b-v0.1"), "mixtral-8x7b-v0.1");
});

test("stripParamInfoKey strips MoE expert-count suffix when paired with size", () => {
  assert.equal(stripParamInfoKey("llama-4-maverick-17b-128e-instruct"), "llama-4-maverick");
  assert.equal(stripParamInfoKey("llama-4-scout-17b-16e-instruct"), "llama-4-scout");
});

test("stripParamInfoKey strips standalone size tokens (B/M)", () => {
  assert.equal(stripParamInfoKey("gemma-3-27b"), "gemma-3");
  assert.equal(stripParamInfoKey("llama-3.1-70b"), "llama-3.1");
  assert.equal(stripParamInfoKey("mistral-7b-instruct"), "mistral");
  assert.equal(stripParamInfoKey("phi-3-medium"), "phi-3-medium");
});

test("stripParamInfoKey strips standalone size tokens (T)", () => {
  assert.equal(stripParamInfoKey("bloom-176b"), "bloom");
});

test("stripParamInfoKey strips quantization suffixes", () => {
  assert.equal(stripParamInfoKey("qwen3-30b-a3b-fp8"), "qwen3");
  assert.equal(stripParamInfoKey("llama-3.1-8b-instruct-fp8"), "llama-3.1");
  assert.equal(stripParamInfoKey("model-awq"), "model");
  assert.equal(stripParamInfoKey("model-gptq"), "model");
  assert.equal(stripParamInfoKey("model-gguf"), "model");
  assert.equal(stripParamInfoKey("model-q4"), "model");
});

test("stripParamInfoKey strips behavior descriptors at trailing pass + forward pass", () => {
  assert.equal(stripParamInfoKey("claude-opus-4-6-thinking"), "claude-opus-4-6");
  assert.equal(stripParamInfoKey("mistral-large-3-675b-instruct-2512"), "mistral-large-3");
  assert.equal(stripParamInfoKey("mistral-large-3-instruct"), "mistral-large-3");
  assert.equal(stripParamInfoKey("model-preview-thinking"), "model");
  assert.equal(stripParamInfoKey("model-experimental"), "model");
  assert.equal(stripParamInfoKey("model-exp"), "model");
  assert.equal(stripParamInfoKey("model-deprecated"), "model");
});

test("stripParamInfoKey strips date suffixes but not release versions", () => {
  assert.equal(stripParamInfoKey("mistral-large-3-675b-instruct-2512"), "mistral-large-3");
  assert.equal(stripParamInfoKey("mistral-small-3.1-24b-instruct-2503"), "mistral-small-3.1");
  assert.equal(stripParamInfoKey("model-2024"), "model-2024");
  assert.equal(stripParamInfoKey("codestral-v0.1"), "codestral-v0.1");
  assert.equal(stripParamInfoKey("mistral-v0.3"), "mistral-v0.3");
  assert.equal(stripParamInfoKey("mixtral-8x7b-v0.1"), "mixtral-8x7b-v0.1");
  assert.equal(stripParamInfoKey("nemotron-nano-9b-v2"), "nemotron-nano-v2");
  assert.equal(stripParamInfoKey("nemotron-nano-v2"), "nemotron-nano-v2");
  assert.equal(stripParamInfoKey("mimo-v2.5"), "mimo-v2.5");
  assert.equal(stripParamInfoKey("mimo-v2-flash"), "mimo-v2-flash");
});

test("stripParamInfoKey strips embedded dates inside descriptor chain", () => {
  assert.equal(stripParamInfoKey("qwen3-235b-a22b-thinking-2507"), "qwen3");
});

test("stripParamInfoKey rejects 4-6 digit dates with month > 12", () => {
  assert.equal(stripParamInfoKey("model-1234"), "model-1234");
  assert.equal(stripParamInfoKey("model-2024"), "model-2024");
});

test("stripParamInfoKey preserves family identifiers (claude, gemini, qwen, ...)", () => {
  assert.equal(stripParamInfoKey("claude-opus-4-6"), "claude-opus-4-6");
  assert.equal(stripParamInfoKey("gemini-2-flash"), "gemini-2-flash");
  assert.equal(stripParamInfoKey("qwen3-coder"), "qwen3-coder");
  assert.equal(stripParamInfoKey("nemotron-3-ultra"), "nemotron-3-ultra");
  assert.equal(stripParamInfoKey("magistral-medium"), "magistral-medium");
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
  assert.equal(stripParamInfoKey("qwen3-coder"), "qwen3-coder");
  assert.equal(stripParamInfoKey("qwen3-vl"), "qwen3-vl");
  assert.equal(stripParamInfoKey("llama-3.2-vision-instruct"), "llama-3.2-vision");
  assert.equal(stripParamInfoKey("nemotron-nano-vl"), "nemotron-nano-vl");
});

test("stripParamInfoKey keeps trailing free token (caller is responsible for :free suffix)", () => {
  assert.equal(stripParamInfoKey("qwen3-coder-free"), "qwen3-coder-free");
  assert.equal(stripParamInfoKey("llama-3.2-free"), "llama-3.2-free");
  assert.equal(stripParamInfoKey("gpt-oss-free"), "gpt-oss-free");
});

test("stripParamInfoKey handles underscore separators", () => {
  assert.equal(stripParamInfoKey("qwen3_coder_30b_a3b_instruct"), "qwen3-coder");
  assert.equal(stripParamInfoKey("llama_3_70b_instruct"), "llama-3");
});

test("stripParamInfoKey falls back to input when nothing remains", () => {
  assert.equal(stripParamInfoKey(""), "");
  assert.equal(stripParamInfoKey("free"), "free");
  assert.equal(stripParamInfoKey("12345"), "12345");
});

test("extractDescriptors extracts meta updates", () => {
  assert.deepEqual(extractDescriptors("claude-opus-4-6-thinking"), { reasoning: true });
  assert.deepEqual(extractDescriptors("qwen3-coder-30b-a3b-instruct"), { code: true, type: "instruct" });
  assert.deepEqual(extractDescriptors("qwen3-vl-30b-a3b-thinking"), { variant: "vl", reasoning: true });
  assert.deepEqual(extractDescriptors("mistral-large-3-exp"), { status: "experimental" });
  assert.deepEqual(extractDescriptors("gemini-2-flash-preview"), { status: "preview" });
  assert.deepEqual(extractDescriptors("mistral-large-3-instruct"), { type: "instruct" });
});

test("extractDescriptors returns empty object when input empty", () => {
  assert.deepEqual(extractDescriptors(""), {});
  assert.deepEqual(extractDescriptors(null), {});
});

test("aliasesFromUpstream generates kebab fallback for upstream IDs", () => {
  assert.deepEqual(aliasesFromUpstream(["openai/gpt-4", "Qwen/Qwen3-32B"]), [
    "openai-gpt-4",
    "openai/gpt-4",
    "Qwen-Qwen3-32B",
    "Qwen/Qwen3-32B",
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
  assert.equal(largestSizeValue("llama-3.3-70b-instruct"), 70);
  assert.equal(largestSizeValue("qwen3-235b-a22b"), 235);
  assert.equal(largestSizeValue("qwen3-coder-480b-a35b-instruct"), 480);
  assert.equal(largestSizeValue("no-size-here"), 0);
});

test("largestSizeValue handles t-scale and decimal sizes", () => {
  assert.equal(largestSizeValue("bloom-176t"), 0);
  assert.equal(largestSizeValue("bloom-176b"), 176);
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
  function toModelKey(modelId) {
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

  assert.equal(toModelKey("qwen/qwen3-coder:free"), "qwen3-coder");
  assert.equal(toModelKey("qwen/qwen3-next-80b-a3b-instruct:free"), "qwen3-next");
  assert.equal(toModelKey("google/gemma-4-26b-a4b-it:free"), "gemma-4");
  assert.equal(toModelKey("google/gemma-4-31b-it:free"), "gemma-4");
  assert.equal(toModelKey("openai/gpt-oss-120b:free"), "gpt-oss");
  assert.equal(toModelKey("openai/gpt-oss-20b:free"), "gpt-oss");
  assert.equal(toModelKey("meta-llama/llama-3.2-3b-instruct:free"), "llama-3.2");
  assert.equal(toModelKey("meta-llama/llama-3.3-70b-instruct:free"), "llama-3.3");
  assert.equal(toModelKey("nex-agi/nex-n2-pro:free"), "nex-n2-pro");
  assert.equal(toModelKey("liquid/lfm-2.5-1.2b-instruct:free"), "lfm-2.5");
  assert.equal(toModelKey("liquid/lfm-2.5-1.2b-thinking:free"), "lfm-2.5");
  assert.equal(toModelKey("nousresearch/hermes-3-llama-3.1-405b:free"), "hermes-3-llama-3.1");
  assert.equal(toModelKey("cognitivecomputations/dolphin-mistral-24b-venice-edition:free"), "dolphin-mistral-venice-edition");
  assert.equal(toModelKey("cohere/north-mini-code:free"), "north-mini-code");
  assert.equal(toModelKey("nvidia/nemotron-3-nano-30b-a3b:free"), "nemotron-3-nano");
  assert.equal(toModelKey("openai/gpt-oss-120b"), "gpt-oss");
  assert.equal(toModelKey("qwen/qwen3-coder-480b-a35b-instruct:free"), "qwen3-coder");
  assert.equal(toModelKey("qwen/qwen3-vl-235b-a22b-thinking"), "qwen3-vl");
  assert.equal(toModelKey("qwen/qwen3-235b-a22b-thinking-2507"), "qwen3");
});

test("toModelKey regression: positive slice would have collapsed keys (must NOT happen)", () => {
  function buggyTrim(cleaned) {
    return cleaned.slice(0, "-free".length);
  }

  const cleaned = stripParamInfoKey("qwen3-next-80b-a3b-instruct-free");
  assert.equal(
    buggyTrim(cleaned),
    "qwen3",
    "positive slice collapse was the historical bug shape",
  );
  assert.equal(
    cleaned.slice(0, -"-free".length),
    "qwen3-next",
    "correct trim keeps family identifier",
  );
});

test("toModelKey preserves openrouter/free special-case", () => {
  function toModelKey(modelId) {
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
