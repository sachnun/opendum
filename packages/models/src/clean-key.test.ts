import { expect, test } from "bun:test";

import {
  stripParamInfoKey,
  extractDescriptors,
  aliasesFromUpstream,
  largestSizeValue,
  PARAMETER_INFO_PATTERNS,
} from "./clean-key.ts";

test("stripParamInfoKey preserves empty input", () => {
  expect(stripParamInfoKey("")).toBe("");
  expect(stripParamInfoKey(null)).toBeNull();
  expect(stripParamInfoKey(undefined)).toBeUndefined();
});

test("stripParamInfoKey strips MoE compound active suffix", () => {
  expect(stripParamInfoKey("mock3-235b-a22b")).toBe("mock3");
  expect(stripParamInfoKey("mock-8x7b-v0.1")).toBe("mock-8x7b-v0.1");
});

test("stripParamInfoKey strips MoE expert-count suffix when paired with size", () => {
  expect(stripParamInfoKey("mock-4-maverick-17b-128e-instruct")).toBe("mock-4-maverick");
  expect(stripParamInfoKey("mock-4-scout-17b-16e-instruct")).toBe("mock-4-scout");
});

test("stripParamInfoKey strips standalone size tokens (B/M)", () => {
  expect(stripParamInfoKey("mock-3-27b")).toBe("mock-3");
  expect(stripParamInfoKey("mock-3.1-70b")).toBe("mock-3.1");
  expect(stripParamInfoKey("mockmodel-7b-instruct")).toBe("mockmodel");
  expect(stripParamInfoKey("mock-3-medium")).toBe("mock-3-medium");
});

test("stripParamInfoKey strips standalone size tokens (T)", () => {
  expect(stripParamInfoKey("mock-176t")).toBe("mock");
});

test("stripParamInfoKey strips quantization suffixes", () => {
  expect(stripParamInfoKey("mock3-30b-a3b-fp8")).toBe("mock3");
  expect(stripParamInfoKey("mock-3.1-8b-instruct-fp8")).toBe("mock-3.1");
  expect(stripParamInfoKey("model-awq")).toBe("model");
  expect(stripParamInfoKey("model-gptq")).toBe("model");
  expect(stripParamInfoKey("model-gguf")).toBe("model");
  expect(stripParamInfoKey("model-q4")).toBe("model");
});

test("stripParamInfoKey strips behavior descriptors at trailing pass + forward pass", () => {
  expect(stripParamInfoKey("mock-opus-4-6-thinking")).toBe("mock-opus-4-6");
  expect(stripParamInfoKey("mock-large-3-675b-instruct-2512")).toBe("mock-large-3");
  expect(stripParamInfoKey("mock-large-3-instruct")).toBe("mock-large-3");
  expect(stripParamInfoKey("model-preview-thinking")).toBe("model");
  expect(stripParamInfoKey("model-experimental")).toBe("model");
  expect(stripParamInfoKey("model-exp")).toBe("model");
  expect(stripParamInfoKey("model-deprecated")).toBe("model");
});

test("stripParamInfoKey strips date suffixes but not release versions", () => {
  expect(stripParamInfoKey("mock-large-3-675b-instruct-2512")).toBe("mock-large-3");
  expect(stripParamInfoKey("mock-small-3.1-24b-instruct-2503")).toBe("mock-small-3.1");
  expect(stripParamInfoKey("model-2024")).toBe("model-2024");
  expect(stripParamInfoKey("mock-v0.1")).toBe("mock-v0.1");
  expect(stripParamInfoKey("mock-v0.3")).toBe("mock-v0.3");
  expect(stripParamInfoKey("mock-8x7b-v0.1")).toBe("mock-8x7b-v0.1");
  expect(stripParamInfoKey("mock-nano-9b-v2")).toBe("mock-nano-v2");
  expect(stripParamInfoKey("mock-nano-v2")).toBe("mock-nano-v2");
  expect(stripParamInfoKey("mock-v2.5")).toBe("mock-v2.5");
  expect(stripParamInfoKey("mock-v2-flash")).toBe("mock-v2-flash");
});

test("stripParamInfoKey strips embedded dates inside descriptor chain", () => {
  expect(stripParamInfoKey("mock3-235b-a22b-thinking-2507")).toBe("mock3");
});

test("stripParamInfoKey strips MMDD date suffixes", () => {
  expect(stripParamInfoKey("mock-v4-flash-0731")).toBe("mock-v4-flash");
  expect(stripParamInfoKey("mock-v4-pro-0813")).toBe("mock-v4-pro");
  expect(stripParamInfoKey("mock-v4-flash-0801")).toBe("mock-v4-flash");
  expect(stripParamInfoKey("mock-chat-v3-0324")).toBe("mock-v3");
  expect(stripParamInfoKey("mock-3.5-turbo-0613")).toBe("mock-3.5-turbo");
});

test("stripParamInfoKey strips YYMMDD date suffixes", () => {
  expect(stripParamInfoKey("mock3-250731")).toBe("mock3");
  expect(stripParamInfoKey("mock-v4-flash-260215")).toBe("mock-v4-flash");
});

test("stripParamInfoKey keeps date tokens when keepDates is set", () => {
  expect(stripParamInfoKey("mock-v4-flash-0731", { keepDates: true })).toBe("mock-v4-flash-0731");
  expect(stripParamInfoKey("mock-large-3-675b-instruct-2512", { keepDates: true })).toBe("mock-large-3-2512");
});

test("stripParamInfoKey rejects 4-6 digit dates with month > 12", () => {
  expect(stripParamInfoKey("model-1234")).toBe("model-1234");
  expect(stripParamInfoKey("model-2024")).toBe("model-2024");
});

test("stripParamInfoKey preserves identifier tokens (families, tiers, modalities)", () => {
  expect(stripParamInfoKey("mock-opus-4-6")).toBe("mock-opus-4-6");
  expect(stripParamInfoKey("mock-2-flash")).toBe("mock-2-flash");
  expect(stripParamInfoKey("mock3-coder")).toBe("mock3-coder");
  expect(stripParamInfoKey("mock-3-ultra")).toBe("mock-3-ultra");
  expect(stripParamInfoKey("mock-medium")).toBe("mock-medium");
});

test("stripParamInfoKey preserves tier words", () => {
  expect(stripParamInfoKey("model-ultra")).toBe("model-ultra");
  expect(stripParamInfoKey("model-super")).toBe("model-super");
  expect(stripParamInfoKey("model-pro")).toBe("model-pro");
  expect(stripParamInfoKey("model-plus")).toBe("model-plus");
  expect(stripParamInfoKey("model-nano")).toBe("model-nano");
  expect(stripParamInfoKey("model-mini")).toBe("model-mini");
  expect(stripParamInfoKey("model-flash")).toBe("model-flash");
  expect(stripParamInfoKey("model-lite")).toBe("model-lite");
  expect(stripParamInfoKey("model-premium")).toBe("model-premium");
});

test("stripParamInfoKey preserves modality descriptors", () => {
  expect(stripParamInfoKey("mock3-coder")).toBe("mock3-coder");
  expect(stripParamInfoKey("mock3-vl")).toBe("mock3-vl");
  expect(stripParamInfoKey("mock-3.2-vision-instruct")).toBe("mock-3.2-vision");
  expect(stripParamInfoKey("mock-nano-vl")).toBe("mock-nano-vl");
});

test("stripParamInfoKey keeps trailing free token (caller is responsible for :free suffix)", () => {
  expect(stripParamInfoKey("mock3-coder-free")).toBe("mock3-coder-free");
  expect(stripParamInfoKey("mock-3.2-free")).toBe("mock-3.2-free");
  expect(stripParamInfoKey("mock-oss-free")).toBe("mock-oss-free");
});

test("stripParamInfoKey handles underscore separators", () => {
  expect(stripParamInfoKey("mock3_coder_30b_a3b_instruct")).toBe("mock3-coder");
  expect(stripParamInfoKey("mock_3_70b_instruct")).toBe("mock-3");
});

test("stripParamInfoKey falls back to input when nothing remains", () => {
  expect(stripParamInfoKey("")).toBe("");
  expect(stripParamInfoKey("free")).toBe("free");
  expect(stripParamInfoKey("12345")).toBe("12345");
});

test("extractDescriptors extracts meta updates", () => {
  expect(extractDescriptors("mock-opus-4-6-thinking")).toEqual({ reasoning: true });
  expect(extractDescriptors("mock3-vl-30b-a3b-thinking")).toEqual({ reasoning: true });
  expect(extractDescriptors("mock3-coder-30b-a3b-instruct")).toEqual({});
  expect(extractDescriptors("mock-large-3-exp")).toEqual({});
  expect(extractDescriptors("mock-2-flash-preview")).toEqual({});
  expect(extractDescriptors("mock-large-3-instruct")).toEqual({});
});

test("extractDescriptors returns empty object when input empty", () => {
  expect(extractDescriptors("")).toEqual({});
  expect(extractDescriptors(null)).toEqual({});
});

test("aliasesFromUpstream generates kebab fallback for upstream IDs", () => {
  expect(aliasesFromUpstream(["vendor/mock-model", "Vendor/Mock2-32B"])).toEqual([
    "vendor-mock-model",
    "vendor/mock-model",
    "Vendor-Mock2-32B",
    "Vendor/Mock2-32B",
  ]);
});

test("aliasesFromUpstream handles empty/null input", () => {
  expect(aliasesFromUpstream()).toEqual([]);
  expect(aliasesFromUpstream([])).toEqual([]);
  expect(aliasesFromUpstream([""])).toEqual([]);
  expect(aliasesFromUpstream(["non/slash", "/", "with-only-content"])).toEqual([
    "non-slash",
    "non/slash",
    "-",
    "/",
    "with-only-content",
  ]);
});

test("aliasesFromUpstream preserves single-name upstream without slash", () => {
  expect(aliasesFromUpstream(["free-model"])).toEqual(["free-model"]);
  expect(aliasesFromUpstream(["vendor/model", "plain"])).toEqual([
    "vendor-model",
    "vendor/model",
    "plain",
  ]);
});

test("largestSizeValue finds dominant size magnitude", () => {
  expect(largestSizeValue("")).toBe(0);
  expect(largestSizeValue("mock-3.3-70b-instruct")).toBe(70);
  expect(largestSizeValue("mock3-235b-a22b")).toBe(235);
  expect(largestSizeValue("mock3-coder-480b-a35b-instruct")).toBe(480);
  expect(largestSizeValue("no-size-here")).toBe(0);
});

test("largestSizeValue handles t-scale and decimal sizes", () => {
  expect(largestSizeValue("mock-176t")).toBe(0);
  expect(largestSizeValue("mock-176b")).toBe(176);
  expect(largestSizeValue("model-1.5b")).toBe(1.5);
});

test("PARAMETER_INFO_PATTERNS exposes regex constants", () => {
  expect(PARAMETER_INFO_PATTERNS.ACTIVE_PARAMS_SUFFIX instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.EXPERT_COUNT_SUFFIX instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.SIZE_BM instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.SIZE_T instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.QUANTIZATION instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.VERSION instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.BEHAVIOR_DESCRIPTOR instanceof RegExp).toBeTruthy();
  expect(PARAMETER_INFO_PATTERNS.MODALITY_DESCRIPTOR instanceof RegExp).toBeTruthy();
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

  expect(toModelKey("vendor/mock3-coder:free")).toBe("mock3-coder");
  expect(toModelKey("vendor/mock3-next-80b-a3b-instruct:free")).toBe("mock3-next");
  expect(toModelKey("vendor/mock-4-26b-a4b-it:free")).toBe("mock-4");
  expect(toModelKey("vendor/mock-4-31b-it:free")).toBe("mock-4");
  expect(toModelKey("vendor/mock-oss-120b:free")).toBe("mock-oss");
  expect(toModelKey("vendor/mock-oss-20b:free")).toBe("mock-oss");
  expect(toModelKey("vendor/mock-3.2-3b-instruct:free")).toBe("mock-3.2");
  expect(toModelKey("vendor/mock-3.3-70b-instruct:free")).toBe("mock-3.3");
  expect(toModelKey("vendor/mock-n2-pro:free")).toBe("mock-n2-pro");
  expect(toModelKey("vendor/mock-2.5-1.2b-instruct:free")).toBe("mock-2.5");
  expect(toModelKey("vendor/mock-2.5-1.2b-thinking:free")).toBe("mock-2.5");
  expect(toModelKey("vendor/mock-3-other-3.1-405b:free")).toBe("mock-3-other-3.1");
  expect(toModelKey("vendor/mock-24b-venice-edition:free")).toBe("mock-venice-edition");
  expect(toModelKey("vendor/mock-mini-code:free")).toBe("mock-mini-code");
  expect(toModelKey("vendor/mock-3-nano-30b-a3b:free")).toBe("mock-3-nano");
  expect(toModelKey("vendor/mock-oss-120b")).toBe("mock-oss");
  expect(toModelKey("vendor/mock3-coder-480b-a35b-instruct:free")).toBe("mock3-coder");
  expect(toModelKey("vendor/mock3-vl-235b-a22b-thinking")).toBe("mock3-vl");
  expect(toModelKey("vendor/mock3-235b-a22b-thinking-2507")).toBe("mock3");
});

test("toModelKey regression: positive slice would have collapsed keys (must NOT happen)", () => {
  function buggyTrim(cleaned: string) {
    return cleaned.slice(0, "-free".length);
  }

  const cleaned = stripParamInfoKey("mock3-next-80b-a3b-instruct-free");
  expect(buggyTrim(cleaned)).toBe("mock3");
  expect(cleaned.slice(0, -"-free".length)).toBe("mock3-next");
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

  expect(toModelKey("openrouter/free")).toBe("openrouter-free");
});
