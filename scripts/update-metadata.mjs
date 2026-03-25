#!/usr/bin/env node

/**
 * Update model TOML metadata from models.dev API data.
 *
 * Usage:
 *   node scripts/update-metadata.mjs
 *
 * Fetches https://models.dev/api.json and updates metadata fields
 * (release_date, knowledge, reasoning, tool_call, attachment, cost, limit, modalities)
 * in existing TOML files while preserving all [opendum] sections.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { buildTomlIndex, serializeToml, collectTomlFiles } from "./toml-utils.mjs";
import { basename } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = resolve(rootDir, "packages/shared/models");

// ---------------------------------------------------------------------------
// Priority: authoritative provider for each model family prefix
// ---------------------------------------------------------------------------

const PRIORITY_PROVIDERS = [
  { prefix: "claude", provider: "anthropic" },
  { prefix: "gpt-", provider: "openai" },
  { prefix: "o1", provider: "openai" },
  { prefix: "o3", provider: "openai" },
  { prefix: "o4", provider: "openai" },
  { prefix: "gemini", provider: "google" },
  { prefix: "deepseek", provider: "deepseek" },
  { prefix: "qwen", provider: "alibaba" },
  { prefix: "qwq", provider: "alibaba" },
  { prefix: "mistral", provider: "mistral" },
  { prefix: "codestral", provider: "mistral" },
  { prefix: "devstral", provider: "mistral" },
  { prefix: "ministral", provider: "mistral" },
  { prefix: "mixtral", provider: "mistral" },
  { prefix: "magistral", provider: "mistral" },
  { prefix: "minimax", provider: "minimax" },
  { prefix: "MiniMax", provider: "minimax" },
  { prefix: "kimi", provider: "moonshotai" },
  { prefix: "glm", provider: "zhipuai" },
  { prefix: "grok", provider: "xai" },
  { prefix: "phi-", provider: "azure" },
  { prefix: "llama", provider: "llama" },
  { prefix: "nemotron", provider: "nvidia" },
  { prefix: "gemma", provider: "google" },
  { prefix: "step-", provider: "stepfun" },
];

function getPriorityProvider(modelId) {
  for (const { prefix, provider } of PRIORITY_PROVIDERS) {
    if (modelId.startsWith(prefix)) return provider;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manual mapping: TOML canonical ID → [provider, apiModelId]
// For models whose canonical name doesn't match any API ID directly.
// ---------------------------------------------------------------------------

const MANUAL_MAP = {
  // Claude older/variant names
  "claude-3-7-sonnet":      ["anthropic", "claude-3-7-sonnet-latest"],
  "claude-3-haiku":         ["anthropic", "claude-3-haiku-20240307"],
  "claude-sonnet-3-5":      ["anthropic", "claude-3-5-sonnet-20241022"],
  "claude-sonnet-3-7":      ["anthropic", "claude-3-7-sonnet-latest"],
  // 1M context variants — same base model metadata
  "claude-opus-4-6-1m":     ["anthropic", "claude-opus-4-6"],
  "claude-sonnet-4-5-1m":   ["anthropic", "claude-sonnet-4-5"],
  "claude-sonnet-4-6-1m":   ["anthropic", "claude-sonnet-4-6"],

  // DeepSeek naming differences
  "deepseek-coder-6.7b-instruct": ["nvidia", "deepseek-ai/deepseek-coder-6.7b-instruct"],
  "deepseek-v3.1-671b":    ["iflowcn", "deepseek-v3.1"],
  "deepseek-v3.2-chat":    ["iflowcn", "deepseek-v3.2"],
  "deepseek-v3.2-reasoner": ["iflowcn", "deepseek-v3.2"],

  // Gemma (provider-prefixed in API)
  "codegemma-1.1-7b":      ["nvidia", "google/codegemma-1.1-7b"],
  "codegemma-7b":           ["nvidia", "google/codegemma-7b"],
  "gemma-2-27b-it":         ["nvidia", "google/gemma-2-27b-it"],
  "gemma-2-2b-it":          ["nvidia", "google/gemma-2-2b-it"],
  "gemma-2-9b-it":          ["groq", "gemma2-9b-it"],
  "gemma-3-1b-it":          ["nvidia", "google/gemma-3-1b-it"],
  "gemma-3-4b-it":          ["nvidia", "google/gemma-3-4b-it"],
  "gemma-3n-e2b-it":        ["nvidia", "google/gemma-3n-e2b-it"],
  "gemma-3n-e4b-it":        ["nvidia", "google/gemma-3n-e4b-it"],
  "gemma3-12b":             ["nvidia", "google/gemma-3-12b-it"],
  "gemma3-27b":             ["nvidia", "google/gemma-3-27b-it"],
  "gemma3-4b":              ["nvidia", "google/gemma-3-4b-it"],

  // Kimi
  "kimi-k2-1t":             ["moonshotai", "kimi-k2-thinking-turbo"],

  // Meta/Llama (provider-prefixed in API)
  "codellama-70b":                    ["nvidia", "meta/codellama-70b"],
  "llama3-70b-instruct":              ["nvidia", "meta/llama3-70b-instruct"],
  "llama3-8b-instruct":               ["nvidia", "meta/llama3-8b-instruct"],
  "llama3-chatqa-1.5-70b":            ["nvidia", "nvidia/llama3-chatqa-1.5-70b"],
  "llama-3.2-1b-instruct":            ["nvidia", "meta/llama-3.2-1b-instruct"],
  "llama-3.2-3b-instruct":            ["inference", "meta/llama-3.2-3b-instruct"],
  "llama-3.1-nemotron-51b-instruct":  ["nvidia", "nvidia/llama-3.1-nemotron-51b-instruct"],
  "llama-3.1-nemotron-70b-instruct":  ["nvidia", "nvidia/llama-3.1-nemotron-70b-instruct"],
  "llama-3.1-nemotron-ultra-253b-v1": ["nvidia", "nvidia/llama-3.1-nemotron-ultra-253b-v1"],
  "llama-3.3-nemotron-super-49b-v1":  ["nvidia", "nvidia/llama-3.3-nemotron-super-49b-v1"],
  "llama-3.3-nemotron-super-49b-v1.5": ["nvidia", "nvidia/llama-3.3-nemotron-super-49b-v1.5"],
  "llama-4-maverick-17b-128e-instruct": ["llama", "llama-4-maverick-17b-128e-instruct-fp8"],

  // Microsoft Phi (provider-prefixed in API)
  "phi-3-vision-128k-instruct": ["nvidia", "microsoft/phi-3-vision-128k-instruct"],
  "phi-3.5-vision-instruct":    ["nvidia", "microsoft/phi-3.5-vision-instruct"],

  // Mistral family
  "codestral-22b-instruct-v0.1":     ["nvidia", "mistralai/codestral-22b-instruct-v0.1"],
  "mamba-codestral-7b-v0.1":         ["nvidia", "mistralai/mamba-codestral-7b-v0.1"],
  "devstral-2-123b":                 ["mistral", "devstral-2512"],
  "devstral-small-2-24b":            ["mistral", "devstral-small-2507"],
  "magistral-small-2506":            ["mistral", "magistral-small"],
  "ministral-3-14b":                 ["mistral", "ministral-8b-latest"],   // closest ministral
  "ministral-3-3b":                  ["mistral", "ministral-3b-latest"],
  "ministral-3-8b":                  ["mistral", "ministral-8b-latest"],
  "mistral-7b-instruct-v0.2":        ["mistral", "mistral-nemo"],
  "mistral-large":                   ["mistral", "mistral-large-2512"],
  "mistral-large-2-instruct":        ["nvidia", "mistralai/mistral-large-2-instruct"],
  "mistral-large-3-675b":            ["nvidia", "mistralai/mistral-large-3-675b-instruct-2512"],
  "mistral-medium-3-instruct":       ["mistral", "mistral-medium-2508"],
  "mistral-nemo-12b-instruct":       ["mistral", "mistral-nemo"],
  "mistral-small-24b-instruct":      ["mistral", "mistral-small-2506"],
  "mistral-small-3.1-24b-instruct-2503": ["nvidia", "mistralai/mistral-small-3.1-24b-instruct-2503"],
  "mistral-small-3.1-24b-instruct":  ["nvidia", "mistralai/mistral-small-3.1-24b-instruct-2503"],
  "mixtral-8x22b-instruct-v0.1":     ["nvidia", "mistralai/mixtral-8x22b-instruct-v0.1"],

  // NVIDIA Nemotron
  "nemotron-3-nano-30b-a3b":     ["nvidia", "nvidia/nemotron-3-nano-30b-a3b"],
  "nemotron-3-nano-30b":         ["nvidia", "nvidia/nemotron-3-nano-30b-a3b"],
  "nemotron-3-super-120b-a12b":  ["nvidia", "nvidia/nemotron-3-super-120b-a12b"],
  "nemotron-4-340b-instruct":    ["nvidia", "nvidia/nemotron-4-340b-instruct"],
  "nemotron-nano-12b-v2-vl":     ["vercel", "nvidia/nemotron-nano-12b-v2-vl"],
  "nemotron-nano-9b-v2":         ["nvidia", "nvidia/nvidia-nemotron-nano-9b-v2"],

  // Qwen naming differences
  "qwen-vl-max-latest":         ["alibaba", "qwen-vl-max"],
  "qwen2.5-7b-instruct":        ["alibaba", "qwen2-5-7b-instruct"],
  "qwen2.5-coder-32b":          ["ovhcloud", "qwen2.5-coder-32b-instruct"],
  "qwen2.5-coder-7b":           ["alibaba", "qwen2-5-coder-7b-instruct"],
  "qwen3-coder-480b":           ["alibaba", "qwen3-coder-480b-a35b-instruct"],
  "qwen3-vl-235b":              ["alibaba", "qwen3-vl-235b-a22b"],
  "qwen3.5-397b":               ["alibaba", "qwen3.5-397b-a17b"],
  "qwen3.5":                    ["alibaba-coding-plan", "qwen3.5-plus"],

  // Other models
  "gpt-oss-120b-medium":        ["qiniu-ai", "gpt-oss-120b"],
  "bielik-11b-v2.6-instruct":   ["cloudferro-sherlock", "speakleash/Bielik-11B-v2.6-Instruct"],
  "dolphin-mistral-24b-venice-edition": ["openrouter", "cognitivecomputations/dolphin-mistral-24b-venice-edition:free"],
  "lfm-2.5-1.2b-instruct":      ["openrouter", "liquid/lfm-2.5-1.2b-instruct:free"],
  "lfm-2.5-1.2b-thinking":      ["openrouter", "liquid/lfm-2.5-1.2b-thinking:free"],
  "seed-oss-36b-instruct":      ["siliconflow", "ByteDance-Seed/Seed-OSS-36B-Instruct"],
  "trinity-large-preview":      ["vercel", "arcee-ai/trinity-large-preview"],
  "trinity-mini":                ["vercel", "arcee-ai/trinity-mini"],
  "hermes-3-llama-3.1-405b":    ["venice", "hermes-3-llama-3.1-405b"],
};

// ---------------------------------------------------------------------------
// Fetch API data
// ---------------------------------------------------------------------------

async function fetchApiData() {
  const url = "https://models.dev/api.json";
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Build flat lookup from API data
// ---------------------------------------------------------------------------

function buildApiLookup(apiData) {
  // First pass: collect all model entries (any provider)
  const flat = new Map();

  for (const [provName, provData] of Object.entries(apiData)) {
    const models = provData.models || {};
    for (const [mid, mdata] of Object.entries(models)) {
      if (!flat.has(mid)) {
        flat.set(mid, { provider: provName, data: mdata });
      }
    }
  }

  // Second pass: override with priority providers
  for (const [provName, provData] of Object.entries(apiData)) {
    const models = provData.models || {};
    for (const [mid, mdata] of Object.entries(models)) {
      const pp = getPriorityProvider(mid);
      if (pp && provName === pp) {
        flat.set(mid, { provider: provName, data: mdata });
      }
    }
  }

  return flat;
}

// ---------------------------------------------------------------------------
// Find highest-paid cost for a model ID across all providers
// ---------------------------------------------------------------------------

function findHighestPaidCost(apiData, apiModelId) {
  let best = null;
  let bestTotal = 0;
  let bestProvider = null;

  for (const [provName, provData] of Object.entries(apiData)) {
    const m = provData.models?.[apiModelId];
    if (!m?.cost) continue;
    const inp = m.cost.input ?? 0;
    const out = m.cost.output ?? 0;
    const total = inp + out;
    if (total > bestTotal) {
      bestTotal = total;
      best = { input: inp, output: out };
      bestProvider = provName;
    }
  }

  return best ? { cost: best, provider: bestProvider } : null;
}

// ---------------------------------------------------------------------------
// Merge API metadata into TOML data (preserving [opendum])
// ---------------------------------------------------------------------------

function mergeMetadata(tomlData, apiModel, paidCost) {
  const merged = { ...tomlData };

  // Top-level scalar fields
  if (apiModel.release_date != null) {
    merged.release_date = apiModel.release_date;
  }
  if (apiModel.knowledge != null) {
    merged.knowledge = apiModel.knowledge;
  }
  if (apiModel.reasoning != null) {
    merged.reasoning = apiModel.reasoning;
  }
  if (apiModel.tool_call != null) {
    merged.tool_call = apiModel.tool_call;
  }
  if (apiModel.attachment != null) {
    merged.attachment = apiModel.attachment;
  }

  // [cost] — use paid cost (highest across all providers)
  if (paidCost) {
    merged.cost = {
      input: paidCost.input,
      output: paidCost.output,
    };
  }

  // [limit]
  if (apiModel.limit) {
    merged.limit = { ...(merged.limit || {}) };
    if (apiModel.limit.context != null) {
      merged.limit.context = apiModel.limit.context;
    }
    if (apiModel.limit.output != null) {
      merged.limit.output = apiModel.limit.output;
    }
  }

  // [modalities]
  if (apiModel.modalities) {
    const input = apiModel.modalities.input;
    const output = apiModel.modalities.output;
    if ((input && input.length > 0) || (output && output.length > 0)) {
      merged.modalities = {
        input: input || [],
        output: output || [],
      };
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const apiData = await fetchApiData();
  const apiLookup = buildApiLookup(apiData);

  console.log(`API lookup: ${apiLookup.size} unique model IDs`);

  const index = buildTomlIndex(modelsDir);
  const modelIds = Object.keys(index).sort();

  console.log(`TOML files: ${modelIds.length}`);

  let matched = 0;
  let updated = 0;
  let skipped = 0;

  for (const modelId of modelIds) {
    const entry = index[modelId];

    // Try direct match first, then manual mapping
    let apiEntry = apiLookup.get(modelId);
    let source = apiEntry ? `${apiEntry.provider}/${modelId}` : null;

    if (!apiEntry && MANUAL_MAP[modelId]) {
      const [provider, apiId] = MANUAL_MAP[modelId];
      const provModels = apiData[provider]?.models;
      if (provModels && provModels[apiId]) {
        apiEntry = { provider, data: provModels[apiId] };
        source = `${provider}/${apiId}`;
      }
    }

    if (!apiEntry) {
      skipped++;
      continue;
    }

    matched++;

    // Determine pricing: use source's cost if paid, otherwise find highest-paid across providers
    const apiModelId = MANUAL_MAP[modelId] ? MANUAL_MAP[modelId][1] : modelId;
    const sourceCost = apiEntry.data.cost;
    const sourceIsFree = !sourceCost || (sourceCost.input === 0 && sourceCost.output === 0);

    let paidCost = null;
    let costSource = null;

    if (!sourceIsFree && sourceCost?.input != null && sourceCost?.output != null) {
      // Source has real pricing — use it
      paidCost = { input: sourceCost.input, output: sourceCost.output };
      costSource = apiEntry.provider;
    } else {
      // Source is free — find highest-paid alternative
      let result = findHighestPaidCost(apiData, apiModelId);
      // Also try the canonical TOML model ID if different
      if (apiModelId !== modelId) {
        const alt = findHighestPaidCost(apiData, modelId);
        if (alt && (!result || (alt.cost.input + alt.cost.output) > (result.cost.input + result.cost.output))) {
          result = alt;
        }
      }
      if (result) {
        paidCost = result.cost;
        costSource = result.provider;
      }
    }

    const oldSerialized = serializeToml(entry.data);
    const merged = mergeMetadata(entry.data, apiEntry.data, paidCost);
    const newSerialized = serializeToml(merged);

    if (oldSerialized !== newSerialized) {
      writeFileSync(entry.path, newSerialized);
      updated++;
      const costInfo = paidCost ? ` cost=$${paidCost.input}/$${paidCost.output} via ${costSource}` : "";
      console.log(`  Updated: ${modelId} (source: ${source}${costInfo})`);
    }
  }

  console.log();
  console.log(`Summary:`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (no API data): ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
