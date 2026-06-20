import test from "node:test";
import assert from "node:assert/strict";
import {
  stripParamInfoKey,
  aliasesFromUpstream,
  extractDescriptors,
  largestSizeValue,
} from "./clean-key.mjs";

const cases = [
  // MoE notation (`-Xb-aYb`) — both size and active collapse
  ["nemotron-3-ultra-550b-a55b", "nemotron-3-ultra"],
  ["nemotron-3-super-120b-a12b", "nemotron-3-super"],
  ["nemotron-3-nano-omni-30b-a3b-reasoning", "nemotron-3-nano-omni"],
  ["qwen3-coder-30b-a3b-instruct", "qwen3-coder"],
  ["qwen3-coder-480b-a35b-instruct", "qwen3-coder"],
  ["qwen3-vl-235b-a22b-thinking", "qwen3-vl"],
  ["qwen3-vl-30b-a3b-instruct", "qwen3-vl"],
  ["qwen3-vl-30b-a3b-thinking", "qwen3-vl"],
  ["qwen3.5-122b-a10b", "qwen3.5"],
  ["qwen3.5-35b-a3b", "qwen3.5"],
  ["qwen3.5-397b-a17b", "qwen3.5"],
  ["qwen3.6-35b-a3b", "qwen3.6"],
  ["qwen3-30b-a3b-fp8", "qwen3"],
  ["gemma-4-26b-a4b-it", "gemma-4"],
  ["diffusiongemma-26b-a4b-it", "diffusiongemma"],
  ["gemma-2-9b-it", "gemma-2"],
  ["gemma-3-12b-it", "gemma-3"],
  ["granite-3.0-3b-a800m-instruct", "granite-3.0"],
  ["ising-calibration-1-35b-a3b", "ising-calibration-1"],

  // Single size only — stripped along with descriptor
  ["llama-3.1-405b-instruct", "llama-3.1"],
  ["qwen2.5-72b-instruct", "qwen2.5"],
  ["qwen3-4b", "qwen3"],
  ["qwen3-14b", "qwen3"],
  ["qwen3-32b", "qwen3"],
  ["qwen3-30b-a3b-instruct-2507", "qwen3"],
  ["qwen3-vl-8b-instruct", "qwen3-vl"],
  ["qwen3-vl-32b-instruct", "qwen3-vl"],
  ["llama-3.2-11b-vision-instruct", "llama-3.2-vision"],
  ["mistral-medium-3.5-128b", "mistral-medium-3.5"],
  ["nemotron-4-340b-instruct", "nemotron-4"],
  ["nemotron-mini-4b-instruct", "nemotron-mini"],

  // Tier words preserved (size identity)
  ["claude-opus-4-6", "claude-opus-4-6"],
  ["claude-sonnet-4-6-1m", "claude-sonnet-4-6"],
  ["gpt-5.4-mini", "gpt-5.4-mini"],
  ["gpt-5.4-nano", "gpt-5.4-nano"],
  ["gemini-2.5-flash", "gemini-2.5-flash"],
  ["gemini-2.5-pro", "gemini-2.5-pro"],
  ["grok-code-fast-1", "grok-code-fast-1"],
  ["gpt-5.1", "gpt-5.1"],

  // Pure behavior descriptors — stripped
  ["claude-opus-4-6-thinking", "claude-opus-4-6"],
  ["gemini-3-pro-preview", "gemini-3-pro"],
  ["gpt-5.1-codex", "gpt-5.1-codex"],
  ["llama-4-maverick-17b-128e-instruct", "llama-4-maverick"],
  ["qwen3-coder-next", "qwen3-coder-next"],
  ["nemotron-nano-9b-v2", "nemotron-nano"],
  ["magistral-small-2506", "magistral-small"],

  // Dates and versions — stripped
  ["mistral-large-3-675b-instruct-2512", "mistral-large-3"],
  ["mistral-small-4-119b-2603", "mistral-small-4"],
  ["mistral-small-3.1-24b-instruct-2503", "mistral-small-3.1"],
  ["ministral-14b-instruct-2512", "ministral"],
  ["kimi-k2-instruct-0905", "kimi-k2"],
  ["llama-3.1-nemotron-ultra-253b-v1", "llama-3.1-nemotron-ultra"],
  ["llama-3.3-nemotron-super-49b-v1.5", "llama-3.3-nemotron-super"],
  ["llama-3.1-nemotron-nano-8b-v1", "llama-3.1-nemotron-nano"],
  ["llama-3.1-nemotron-nano-vl-8b-v1", "llama-3.1-nemotron-nano-vl"],
  ["codestral-22b-instruct-v0.1", "codestral"],
  ["mamba-codestral-7b-v0.1", "mamba-codestral"],
  ["mixtral-8x22b-instruct-v0.1", "mixtral-8x22b"],
  ["mistral-7b-instruct-v0.3", "mistral"],
  ["riva-translate-4b-instruct-v1.1", "riva-translate"],
  ["devstral-2-123b-instruct-2512", "devstral-2"],

  // Modality/coder/vl/vision/omni identifiers preserved when in mid-position
  ["nemotron-nano-vl", "nemotron-nano-vl"],
  ["nemotron-nano-12b-vl", "nemotron-nano-vl"],
  ["nemotron-3-nano-omni", "nemotron-3-nano-omni"],
  ["qwen3-vl-thinking", "qwen3-vl"],
];

test("stripParamInfoKey matches all known cases", () => {
  let failures = 0;
  for (const [input, expected] of cases) {
    const got = stripParamInfoKey(input);
    if (got !== expected) {
      failures += 1;
      console.error(`FAIL: stripParamInfoKey(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(expected)}`);
    } else {
      assert.equal(got, expected);
    }
  }
  assert.equal(failures, 0, `${failures} case(s) failed`);
});

test("aliasesFromUpstream derives kebab fallback for slash ids", () => {
  const aliases = aliasesFromUpstream([
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ]);
  assert.deepEqual(aliases.sort(), [
    "nvidia-nemotron-3-ultra-550b-a55b",
    "nvidia-nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ]);
});

test("largestSizeValue picks the dominant size token", () => {
  assert.equal(largestSizeValue("nemotron-3-ultra-550b-a55b"), 550);
  assert.equal(largestSizeValue("qwen3-coder-480b-a35b-instruct"), 480);
  assert.equal(largestSizeValue("qwen3-30b-a3b-fp8"), 30);
  assert.equal(largestSizeValue("mistral-medium-3.5-128b"), 128);
  assert.equal(largestSizeValue("claude-opus-4-6"), 0);
});

test("extractDescriptors captures type/status/code/variant", () => {
  assert.deepEqual(
    extractDescriptors("qwen3-coder-30b-a3b-instruct"),
    { type: "instruct", code: true }
  );
  assert.deepEqual(
    extractDescriptors("claude-opus-4-6-thinking"),
    { reasoning: true }
  );
  assert.deepEqual(
    extractDescriptors("gemini-3-pro-preview"),
    { status: "preview" }
  );
  assert.deepEqual(
    extractDescriptors("nemotron-3-nano-omni"),
    { variant: "omni" }
  );
  assert.deepEqual(
    extractDescriptors("llama-3.2-11b-vision-instruct"),
    { type: "instruct", variant: "vision" }
  );
  assert.deepEqual(
    extractDescriptors("claude-opus-4-6"),
    {}
  );
});
