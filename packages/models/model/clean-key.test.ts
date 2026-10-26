import { expect, test } from "bun:test";

import {
  stripParams,
  extractDescriptors,
  aliasesOf,
  largestSize,
  PARAMETER_INFO_PATTERNS,
} from "./clean-key.ts";

test("stripParams preserves empty input", () => {
  expect(stripParams("")).toBe("");
  expect(stripParams(null)).toBeNull();
  expect(stripParams(undefined)).toBeUndefined();
});

test("stripParams strips MoE compound active suffix", () => {
  expect(stripParams("mock3-235b-a22b")).toBe("mock3");
  expect(stripParams("mock-8x7b-v0.1")).toBe("mock-8x7b-v0.1");
});

test("stripParams strips MoE expert-count suffix when paired with size", () => {
  expect(stripParams("mock-4-maverick-17b-128e-instruct")).toBe("mock-4-maverick");
  expect(stripParams("mock-4-scout-17b-16e-instruct")).toBe("mock-4-scout");
});

test("stripParams strips standalone size tokens (B/M)", () => {
  expect(stripParams("mock-3-27b")).toBe("mock-3");
  expect(stripParams("mock-3.1-70b")).toBe("mock-3.1");
  expect(stripParams("mockmodel-7b-instruct")).toBe("mockmodel");
  expect(stripParams("mock-3-medium")).toBe("mock-3-medium");
});

test("stripParams strips standalone size tokens (T)", () => {
  expect(stripParams("mock-176t")).toBe("mock");
});

test("stripParams strips quantization suffixes", () => {
  expect(stripParams("mock3-30b-a3b-fp8")).toBe("mock3");
  expect(stripParams("mock-3.1-8b-instruct-fp8")).toBe("mock-3.1");
  expect(stripParams("model-awq")).toBe("model");
  expect(stripParams("model-gptq")).toBe("model");
  expect(stripParams("model-gguf")).toBe("model");
  expect(stripParams("model-q4")).toBe("model");
});

test("stripParams strips behavior descriptors at trailing pass + forward pass", () => {
  expect(stripParams("mock-opus-4-6-thinking")).toBe("mock-opus-4-6");
  expect(stripParams("mock-large-3-675b-instruct-2512")).toBe("mock-large-3");
  expect(stripParams("mock-large-3-instruct")).toBe("mock-large-3");
  expect(stripParams("model-preview-thinking")).toBe("model");
  expect(stripParams("model-experimental")).toBe("model");
  expect(stripParams("model-exp")).toBe("model");
  expect(stripParams("model-deprecated")).toBe("model");
});

test("stripParams strips date suffixes but not release versions", () => {
  expect(stripParams("mock-large-3-675b-instruct-2512")).toBe("mock-large-3");
  expect(stripParams("mock-small-3.1-24b-instruct-2503")).toBe("mock-small-3.1");
  expect(stripParams("model-2024")).toBe("model-2024");
  expect(stripParams("mock-v0.1")).toBe("mock-v0.1");
  expect(stripParams("mock-v0.3")).toBe("mock-v0.3");
  expect(stripParams("mock-8x7b-v0.1")).toBe("mock-8x7b-v0.1");
  expect(stripParams("mock-nano-9b-v2")).toBe("mock-nano-v2");
  expect(stripParams("mock-nano-v2")).toBe("mock-nano-v2");
  expect(stripParams("mock-v2.5")).toBe("mock-v2.5");
  expect(stripParams("mock-v2-flash")).toBe("mock-v2-flash");
});

test("stripParams strips embedded dates inside descriptor chain", () => {
  expect(stripParams("mock3-235b-a22b-thinking-2507")).toBe("mock3");
});

test("stripParams strips MMDD date suffixes", () => {
  expect(stripParams("mock-v4-flash-0731")).toBe("mock-v4-flash");
  expect(stripParams("mock-v4-pro-0813")).toBe("mock-v4-pro");
  expect(stripParams("mock-v4-flash-0801")).toBe("mock-v4-flash");
  expect(stripParams("mock-chat-v3-0324")).toBe("mock-v3");
  expect(stripParams("mock-3.5-turbo-0613")).toBe("mock-3.5-turbo");
});

test("stripParams strips YYMMDD date suffixes", () => {
  expect(stripParams("mock3-250731")).toBe("mock3");
  expect(stripParams("mock-v4-flash-260215")).toBe("mock-v4-flash");
});

test("stripParams keeps date tokens when keepDates is set", () => {
  expect(stripParams("mock-v4-flash-0731", { keepDates: true })).toBe("mock-v4-flash-0731");
  expect(stripParams("mock-large-3-675b-instruct-2512", { keepDates: true })).toBe("mock-large-3-2512");
});

test("stripParams rejects 4-6 digit dates with month > 12", () => {
  expect(stripParams("model-1234")).toBe("model-1234");
  expect(stripParams("model-2024")).toBe("model-2024");
});

test("stripParams preserves identifier tokens (families, tiers, modalities)", () => {
  expect(stripParams("mock-opus-4-6")).toBe("mock-opus-4-6");
  expect(stripParams("mock-2-flash")).toBe("mock-2-flash");
  expect(stripParams("mock3-coder")).toBe("mock3-coder");
  expect(stripParams("mock-3-ultra")).toBe("mock-3-ultra");
  expect(stripParams("mock-medium")).toBe("mock-medium");
});

test("stripParams preserves tier words", () => {
  expect(stripParams("model-ultra")).toBe("model-ultra");
  expect(stripParams("model-super")).toBe("model-super");
  expect(stripParams("model-pro")).toBe("model-pro");
  expect(stripParams("model-plus")).toBe("model-plus");
  expect(stripParams("model-nano")).toBe("model-nano");
  expect(stripParams("model-mini")).toBe("model-mini");
  expect(stripParams("model-flash")).toBe("model-flash");
  expect(stripParams("model-lite")).toBe("model-lite");
  expect(stripParams("model-premium")).toBe("model-premium");
});

test("stripParams preserves modality descriptors", () => {
  expect(stripParams("mock3-coder")).toBe("mock3-coder");
  expect(stripParams("mock3-vl")).toBe("mock3-vl");
  expect(stripParams("mock-3.2-vision-instruct")).toBe("mock-3.2-vision");
  expect(stripParams("mock-nano-vl")).toBe("mock-nano-vl");
});

test("stripParams keeps trailing free token (caller is responsible for :free suffix)", () => {
  expect(stripParams("mock3-coder-free")).toBe("mock3-coder-free");
  expect(stripParams("mock-3.2-free")).toBe("mock-3.2-free");
  expect(stripParams("mock-oss-free")).toBe("mock-oss-free");
});

test("stripParams handles underscore separators", () => {
  expect(stripParams("mock3_coder_30b_a3b_instruct")).toBe("mock3-coder");
  expect(stripParams("mock_3_70b_instruct")).toBe("mock-3");
});

test("stripParams falls back to input when nothing remains", () => {
  expect(stripParams("")).toBe("");
  expect(stripParams("free")).toBe("free");
  expect(stripParams("12345")).toBe("12345");
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

test("aliasesOf generates kebab fallback for upstream IDs", () => {
  expect(aliasesOf(["vendor/mock-model", "Vendor/Mock2-32B"])).toEqual([
    "vendor-mock-model",
    "vendor/mock-model",
    "Vendor-Mock2-32B",
    "Vendor/Mock2-32B",
  ]);
});

test("aliasesOf handles empty/null input", () => {
  expect(aliasesOf()).toEqual([]);
  expect(aliasesOf([])).toEqual([]);
  expect(aliasesOf([""])).toEqual([]);
  expect(aliasesOf(["non/slash", "/", "with-only-content"])).toEqual([
    "non-slash",
    "non/slash",
    "-",
    "/",
    "with-only-content",
  ]);
});

test("aliasesOf preserves single-name upstream without slash", () => {
  expect(aliasesOf(["free-model"])).toEqual(["free-model"]);
  expect(aliasesOf(["vendor/model", "plain"])).toEqual([
    "vendor-model",
    "vendor/model",
    "plain",
  ]);
});

test("largestSize finds dominant size magnitude", () => {
  expect(largestSize("")).toBe(0);
  expect(largestSize("mock-3.3-70b-instruct")).toBe(70);
  expect(largestSize("mock3-235b-a22b")).toBe(235);
  expect(largestSize("mock3-coder-480b-a35b-instruct")).toBe(480);
  expect(largestSize("no-size-here")).toBe(0);
});

test("largestSize handles t-scale and decimal sizes", () => {
  expect(largestSize("mock-176t")).toBe(0);
  expect(largestSize("mock-176b")).toBe(176);
  expect(largestSize("model-1.5b")).toBe(1.5);
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

test("modelKey helper (openrouter.mjs) correctly trims trailing -free", () => {
  function modelKey(modelId: string) {
    const normalizedModelId = modelId.replace(/^library\//, "");
    const strippedId =
      normalizedModelId === "openrouter/free"
        ? normalizedModelId
        : normalizedModelId.includes("/")
          ? normalizedModelId.slice(normalizedModelId.indexOf("/") + 1)
          : normalizedModelId;

    const modelKey = strippedId
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-");

    const cleaned = stripParams(modelKey);
    if (modelKey !== "openrouter-free" && cleaned.endsWith("-free")) {
      return cleaned.slice(0, -"-free".length);
    }

    return cleaned;
  }

  expect(modelKey("vendor/mock3-coder:free")).toBe("mock3-coder");
  expect(modelKey("vendor/mock3-next-80b-a3b-instruct:free")).toBe("mock3-next");
  expect(modelKey("vendor/mock-4-26b-a4b-it:free")).toBe("mock-4");
  expect(modelKey("vendor/mock-4-31b-it:free")).toBe("mock-4");
  expect(modelKey("vendor/mock-oss-120b:free")).toBe("mock-oss");
  expect(modelKey("vendor/mock-oss-20b:free")).toBe("mock-oss");
  expect(modelKey("vendor/mock-3.2-3b-instruct:free")).toBe("mock-3.2");
  expect(modelKey("vendor/mock-3.3-70b-instruct:free")).toBe("mock-3.3");
  expect(modelKey("vendor/mock-n2-pro:free")).toBe("mock-n2-pro");
  expect(modelKey("vendor/mock-2.5-1.2b-instruct:free")).toBe("mock-2.5");
  expect(modelKey("vendor/mock-2.5-1.2b-thinking:free")).toBe("mock-2.5");
  expect(modelKey("vendor/mock-3-other-3.1-405b:free")).toBe("mock-3-other-3.1");
  expect(modelKey("vendor/mock-24b-venice-edition:free")).toBe("mock-venice-edition");
  expect(modelKey("vendor/mock-mini-code:free")).toBe("mock-mini-code");
  expect(modelKey("vendor/mock-3-nano-30b-a3b:free")).toBe("mock-3-nano");
  expect(modelKey("vendor/mock-oss-120b")).toBe("mock-oss");
  expect(modelKey("vendor/mock3-coder-480b-a35b-instruct:free")).toBe("mock3-coder");
  expect(modelKey("vendor/mock3-vl-235b-a22b-thinking")).toBe("mock3-vl");
  expect(modelKey("vendor/mock3-235b-a22b-thinking-2507")).toBe("mock3");
});

test("modelKey regression: positive slice would have collapsed keys (must NOT happen)", () => {
  function buggyTrim(cleaned: string) {
    return cleaned.slice(0, "-free".length);
  }

  const cleaned = stripParams("mock3-next-80b-a3b-instruct-free");
  expect(buggyTrim(cleaned)).toBe("mock3");
  expect(cleaned.slice(0, -"-free".length)).toBe("mock3-next");
});

test("modelKey preserves openrouter/free special-case", () => {
  function modelKey(modelId: string) {
    const normalizedModelId = modelId.replace(/^library\//, "");
    const strippedId =
      normalizedModelId === "openrouter/free"
        ? normalizedModelId
        : normalizedModelId.includes("/")
          ? normalizedModelId.slice(normalizedModelId.indexOf("/") + 1)
          : normalizedModelId;

    const modelKey = strippedId
      .replace(/[:/]/g, "-")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/-{2,}/g, "-");

    const cleaned = stripParams(modelKey);
    if (modelKey !== "openrouter-free" && cleaned.endsWith("-free")) {
      return cleaned.slice(0, -"-free".length);
    }

    return cleaned;
  }

  expect(modelKey("openrouter/free")).toBe("openrouter-free");
});
