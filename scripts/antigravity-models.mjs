#!/usr/bin/env node

/**
 * Antigravity model discovery script.
 *
 * Fetches the public Google Antigravity model documentation and syncs the
 * reasoning models into the JSON model registry. The parser intentionally works
 * from display names instead of a fixed model table so new Gemini/Claude/GPT-OSS
 * versions can flow through without updating a hardcoded list.
 *
 * Source: https://antigravity.google/assets/docs/agent/models.md
 * Rendered at: https://antigravity.google/docs/models
 *
 * Usage:
 *   node scripts/antigravity-models.mjs
 *   node scripts/antigravity-models.mjs --dry-run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels, writeModelJson } from "./model-registry.mjs";
import { sleep, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "./lib/shared.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ANTIGRAVITY_MODELS_URL =
  "https://antigravity.google/assets/docs/antigravity-2-0/models.md";
const PROVIDER_NAME = "antigravity";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = resolve(rootDir, "models");

const QUOTA_TS_PATH = resolve(
  rootDir,
  "apps/dashboard/server/lib/providers/antigravity/quota.ts"
);

const GEMINI_TEXT_MODALITIES = {
  input: ["text", "image", "video", "audio", "pdf"],
  output: ["text"],
};

const CLAUDE_MODALITIES = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

const TEXT_ONLY_MODALITIES = {
  input: ["text"],
  output: ["text"],
};

const GEMINI_LEVEL_THINKING = {
  high: "high",
  low: "low",
  medium: "medium",
  none: "minimal",
  xhigh: "high",
};

const GEMINI_FLASH_BUDGETS = {
  high: 24576,
  low: 6144,
  medium: 12288,
  xhigh: 24576,
};

const GEMINI_PRO_BUDGETS = {
  high: 32768,
  low: 8192,
  medium: 16384,
  xhigh: 32768,
};

const GEMINI_35_FLASH_LEVELS = ["minimal", "low", "medium", "high"];

// Official docs expose user-facing labels, but cloudcode-pa v1internal can use
// backend IDs that are not derivable from the display name alone.
const DOCUMENTED_BACKEND_OVERRIDES = new Map([
  ["Gemini 3.5 Flash", { key: "gemini-3.5-flash", upstream: "gemini-3.5-flash-medium" }],
  ["Claude Sonnet 4.6 (thinking)", { key: "claude-sonnet-4-6", upstream: "claude-sonnet-4-6" }],
  ["Claude Opus 4.6 (thinking)", { key: "claude-opus-4-6", upstream: "claude-opus-4-6-thinking" }],
  ["GPT-OSS-120b", { key: "gpt-oss-120b", upstream: "gpt-oss-120b-medium" }],
]);

const MODEL_ALIASES_BY_KEY = new Map([
  ["gemini-3.5-flash", GEMINI_35_FLASH_LEVELS.map((level) => `gemini-3.5-flash-${level}`)],
]);

// Models proven to exist in the Antigravity backend but not shown in the public
// reasoning-model docs. Kept separate so documented model changes still sync.
const PRESERVED_EXTRAS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-flash-image-preview",
  "gemini-3-pro-image-preview",
];

const MANAGED_PROVIDER_CONFIG_KEYS = [
  "anthropic_beta",
  "anthropic_beta_thinking",
  "convert_external_images",
  "force_stream_non_stream",
  "inject_thought_signature",
  "sanitize_tool_blocks",
  "scrub_model_artifacts",
  "signature_family",
  "strict_thought_signatures",
  "strict_tool_schema",
  "system_instruction",
  "thinking_budgets",
  "thinking_format",
  "thinking_levels",
  "thinking_model",
  "top_p_min_095",
];

// ---------------------------------------------------------------------------
// Antigravity docs parsing
// ---------------------------------------------------------------------------

function parseReasoningModelNames(markdown) {
  const section = markdown.match(/## Reasoning Model\s+([\s\S]*?)(?:\n## |$)/);
  if (!section) {
    throw new Error("Could not find Reasoning Model section in Antigravity docs.");
  }

  const models = [];
  for (const line of section[1].split(/\r?\n/)) {
    const match = line.match(/^\s*[*-]\s+(.+?)\s*$/);
    if (!match) continue;

    const name = stripMarkdown(match[1]).trim();
    if (!name) continue;

    // Stop before the Additional Models prose if the section structure changes.
    if (/^nano banana/i.test(name)) continue;
    models.push(name);
  }

  const unique = [...new Set(models)];
  if (unique.length === 0) {
    throw new Error("No Antigravity reasoning models found in official docs.");
  }

  return unique;
}

function stripMarkdown(value) {
  return value
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\\\s*$/g, "")
    .trim();
}

function modelIDFromDisplayName(displayName) {
  const cleaned = displayName
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bpreview\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const lower = cleaned.toLowerCase();
  const gptOSS = lower.match(/\bgpt\s*[- ]?\s*oss\s*[- ]?\s*(\d+)\s*b\b/);
  if (gptOSS) return `gpt-oss-${gptOSS[1]}b`;

  let id = lower
    .replace(/\b(google|anthropic|openai)\b/g, "")
    .replace(/\b(claude|gemini)\s+(opus|sonnet|haiku|flash|pro)/g, "$1-$2")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (id.startsWith("claude-")) {
    id = id.replace(/\.(?=\d)/g, "-");
  }

  return id;
}

function canonicalizeDiscoveredModel(displayName) {
  const lower = displayName.toLowerCase();
  const override = DOCUMENTED_BACKEND_OVERRIDES.get(displayName);
  if (override) {
    return {
      displayName,
      key: override.key,
      upstream: override.upstream,
      thinking: lower.includes("thinking"),
    };
  }

  const base = modelIDFromDisplayName(displayName);
  if (!base) return null;

  const entry = {
    displayName,
    key: base,
    upstream: base,
    thinking: lower.includes("thinking"),
  };

  if (base.startsWith("gemini-")) {
    if (base === "gemini-3-pro") {
      entry.key = "gemini-3.1-pro-preview";
      entry.upstream = lower.includes("low") ? "gemini-3.1-pro-low" : "gemini-3.1-pro-high";
      return entry;
    }
    if (/^gemini-\d+(?:\.\d+)*-pro$/.test(base) && lower.includes("low")) {
      entry.key = `${base}-preview`;
      entry.upstream = `${base}-low`;
      return entry;
    }
    if (/^gemini-\d+(?:\.\d+)*-pro$/.test(base) && lower.includes("high")) {
      entry.key = `${base}-preview`;
      entry.upstream = `${base}-high`;
      return entry;
    }
    if (base === "gemini-3-flash") {
      entry.key = "gemini-3-flash-preview";
      entry.upstream = "gemini-3-flash";
      return entry;
    }
  }

  if (base.startsWith("claude-") && lower.includes("thinking")) {
    entry.key = base;
    entry.upstream = `${base}-thinking`;
  }

  return entry;
}

function buildDiscoveredModelMap(displayNames) {
  const map = new Map();
  const ranks = new Map();
  const discovered = [];

  for (const displayName of displayNames) {
    const entry = canonicalizeDiscoveredModel(displayName);
    if (!entry) continue;
    discovered.push(entry);

    const rank = upstreamRank(entry.upstream);
    if (!map.has(entry.key) || rank > (ranks.get(entry.key) ?? 0)) {
      map.set(entry.key, entry.upstream);
      ranks.set(entry.key, rank);
    }
  }

  if (map.size === 0) {
    throw new Error("No Antigravity model IDs could be derived from official docs.");
  }

  return { modelMap: map, discovered };
}

function upstreamRank(upstream) {
  if (/-high$/.test(upstream)) return 3;
  if (/-medium$/.test(upstream)) return 2;
  if (/-low$/.test(upstream)) return 1;
  return 0;
}

function mergePreservedExtras(modelMap) {
  const index = buildModelIndex(modelsDir);
  const extras = [];

  for (const key of PRESERVED_EXTRAS) {
    if (modelMap.has(key)) continue;

    const existing = findModelEntry(index, key);
    const upstream = existing
      ? getExistingProviderUpstream(existing, PROVIDER_NAME)
      : inferUpstream(key);

    modelMap.set(key, upstream);
    extras.push({ key, upstream });
  }

  return extras;
}

function findModelEntry(index, modelKey) {
  const exact = Object.values(index).find((entry) => entry.fileId === modelKey || entry.id === modelKey);
  if (exact) return exact;

  return Object.values(index).find((entry) => {
    if (entry.data.ignored) return false;
    return (entry.data.aliases || []).includes(modelKey);
  }) || null;
}

function getExistingProviderUpstream(entry, provider) {
  const upstream = entry.data.providerConfig?.[provider]?.upstream;
  if (typeof upstream === "string" && upstream.trim() !== "") {
    return upstream.trim();
  }
  return entry.id || entry.fileId;
}

function inferUpstream(modelKey) {
  if (/^gemini-.*-image-preview$/.test(modelKey)) {
    return modelKey.replace(/-preview$/, "");
  }
  if (modelKey === "gemini-3-flash-preview") {
    return "gemini-3-flash";
  }
  return modelKey;
}

// ---------------------------------------------------------------------------
// Provider config and metadata
// ---------------------------------------------------------------------------

function buildProviderConfigByModel(modelMap, thinkingClaudeModelKeys = new Set()) {
  const config = new Map();
  const index = buildModelIndex(modelsDir);

  for (const [key, upstream] of modelMap.entries()) {
    const existing = findModelEntry(index, key);
    const existingProviderConfig = existing?.data.providerConfig?.[PROVIDER_NAME] || {};
    if (existing && !isManagedModel(key)) {
      config.set(key, Object.fromEntries(MANAGED_PROVIDER_CONFIG_KEYS.map((managedKey) => [managedKey, existingProviderConfig[managedKey]])));
      continue;
    }

    if (key.startsWith("gemini-")) {
      config.set(key, geminiProviderConfig(key));
      continue;
    }

    if (key.startsWith("claude-")) {
      config.set(key, claudeProviderConfig(upstream, thinkingClaudeModelKeys.has(key)));
      continue;
    }
  }

  return config;
}

function isManagedModel(modelKey) {
  return modelKey.startsWith("gemini-") && !isGeminiImageModel(modelKey) ||
    modelKey.startsWith("claude-");
}

function geminiProviderConfig(modelKey) {
  const config = {
    inject_thought_signature: true,
    scrub_model_artifacts: true,
    signature_family: signatureFamily(modelKey),
  };

  if (isGeminiTextReasoningModel(modelKey)) {
    config.system_instruction = true;
  }

  if (usesGeminiLevelThinking(modelKey)) {
    config.thinking_format = "level";
    config.thinking_levels = GEMINI_LEVEL_THINKING;
  } else if (!isGeminiImageModel(modelKey)) {
    config.thinking_format = "budget";
    config.thinking_budgets = modelKey.includes("pro")
      ? GEMINI_PRO_BUDGETS
      : GEMINI_FLASH_BUDGETS;
  }

  return config;
}

function claudeProviderConfig(upstream, documentedThinking = false) {
  const thinking = documentedThinking || upstream.endsWith("-thinking");
  return {
    anthropic_beta: true,
    ...(thinking ? { anthropic_beta_thinking: true } : {}),
    convert_external_images: true,
    force_stream_non_stream: true,
    sanitize_tool_blocks: true,
    signature_family: "claude",
    strict_thought_signatures: true,
    strict_tool_schema: true,
    system_instruction: true,
    ...(thinking ? { thinking_model: true } : {}),
    top_p_min_095: true,
  };
}

function usesGeminiLevelThinking(modelKey) {
  return /^gemini-3/.test(modelKey) && !modelKey.includes("pro") && !isGeminiImageModel(modelKey);
}

function isGeminiTextReasoningModel(modelKey) {
  return /^gemini-3/.test(modelKey) && !isGeminiImageModel(modelKey);
}

function isGeminiImageModel(modelKey) {
  return modelKey.includes("image");
}

function signatureFamily(modelKey) {
  if (modelKey.includes("pro")) return "gemini-pro";
  return "gemini-flash";
}

function enrichModelMetadata(result, documentedModelKeys) {
  const index = buildModelIndex(modelsDir);
  const changedKeys = new Set([...result.added, ...result.updated]);

  for (const modelKey of changedKeys) {
    const entry = findModelEntry(index, modelKey);
    if (!entry) continue;

    const data = entry.data;
    let changed = false;
    if (documentedModelKeys.has(modelKey) && data.ignored) {
      delete data.ignored;
      changed = true;
    }

    const nextMeta = inferMetadata(modelKey);
    if (!nextMeta) {
      if (changed) writeModelJson(entry.path, data);
      continue;
    }

    if (JSON.stringify(data.meta) !== JSON.stringify(nextMeta)) {
      data.meta = nextMeta;
      changed = true;
    }

    if (!data.family && familyForModel(entry.id || entry.fileId)) {
      data.family = familyForModel(entry.id || entry.fileId);
      changed = true;
    }

    const desiredAliases = MODEL_ALIASES_BY_KEY.get(modelKey) || [];
    if (desiredAliases.length > 0) {
      const aliases = new Set(data.aliases || []);
      for (const alias of desiredAliases) {
        aliases.add(alias);
      }
      const nextAliases = [...aliases].sort();
      if (JSON.stringify(data.aliases || []) !== JSON.stringify(nextAliases)) {
        data.aliases = nextAliases;
        changed = true;
      }
    }

    if (changed) {
      writeModelJson(entry.path, data);
    }
  }
}

function inferMetadata(modelKey) {
  if (modelKey.startsWith("gemini-")) {
    return {
      reasoning: !isGeminiImageModel(modelKey),
      toolCall: !isGeminiImageModel(modelKey),
      vision: true,
      modalities: isGeminiImageModel(modelKey)
        ? { input: ["text", "image", "pdf"], output: modelKey.includes("flash-image") ? ["text", "image"] : ["text"] }
        : GEMINI_TEXT_MODALITIES,
    };
  }
  if (modelKey.startsWith("claude-")) {
    return {
      reasoning: true,
      toolCall: true,
      vision: true,
      modalities: CLAUDE_MODALITIES,
    };
  }
  if (modelKey.startsWith("gpt-oss-")) {
    return {
      reasoning: true,
      toolCall: true,
      vision: false,
      modalities: TEXT_ONLY_MODALITIES,
    };
  }
  return null;
}

function familyForModel(modelKey) {
  if (modelKey.startsWith("gemini-")) return "Google";
  if (modelKey.startsWith("claude-")) return "Anthropic";
  if (modelKey.startsWith("gpt-oss-")) return "OpenAI";
  return null;
}

// ---------------------------------------------------------------------------
// Sync JSON files
// ---------------------------------------------------------------------------

function syncJson(modelMap, providerConfigByModel, dryRun) {
  if (dryRun) {
    console.log("[antigravity] Dry run - no JSON files modified.");

    const index = buildModelIndex(modelsDir);
    const wouldRemove = [];
    const wouldKeep = [];

    for (const [modelId, entry] of Object.entries(index)) {
      const publicId = entry.id || modelId;
      const providers = entry.data.providers || [];
      if (!providers.includes(PROVIDER_NAME)) continue;

      if (modelMap.has(modelId) || modelMap.has(publicId)) {
        wouldKeep.push(publicId);
      } else {
        wouldRemove.push(publicId);
      }
    }

    const wouldAdd = [];
    const wouldUpdate = [];
    for (const [key, upstream] of modelMap.entries()) {
      const existing = findModelEntry(index, key);
      if (!existing || !(existing.data.providers || []).includes(PROVIDER_NAME)) {
        wouldAdd.push(key);
        continue;
      }

      const cfg = existing.data.providerConfig?.[PROVIDER_NAME] || {};
      const extraConfig = providerConfigByModel.get(key) || {};
      const existingUpstream = getExistingProviderUpstream(existing, PROVIDER_NAME);
      if (
        existingUpstream !== upstream ||
        MANAGED_PROVIDER_CONFIG_KEYS.some((managedKey) => JSON.stringify(cfg[managedKey]) !== JSON.stringify(extraConfig[managedKey]))
      ) {
        wouldUpdate.push(key);
      }
    }

    if (wouldRemove.length > 0) {
      console.log(`  Would REMOVE antigravity from: ${wouldRemove.join(", ")}`);
    }
    if (wouldAdd.length > 0) {
      console.log(`  Would ADD antigravity to: ${wouldAdd.join(", ")}`);
    }
    if (wouldUpdate.length > 0) {
      console.log(`  Would UPDATE antigravity config for: ${wouldUpdate.join(", ")}`);
    }
    if (wouldKeep.length > 0) {
      console.log(`  Would KEEP: ${wouldKeep.join(", ")}`);
    }

    return { added: wouldAdd, removed: wouldRemove, updated: wouldUpdate };
  }

  return syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: MANAGED_PROVIDER_CONFIG_KEYS,
  });
}

// ---------------------------------------------------------------------------
// Update quota.ts
// ---------------------------------------------------------------------------

function updateQuotaTs(modelMap, dryRun) {
  const source = readFileSync(QUOTA_TS_PATH, "utf-8");
  let updated = source;
  const index = buildModelIndex(modelsDir);

  const apiToUser = {};
  for (const [key, upstream] of modelMap.entries()) {
    if (key !== upstream) {
      apiToUser[upstream] = key;
    }

    const entry = findModelEntry(index, key);
    for (const alias of entry?.data.aliases || []) {
      if (alias !== key) {
        apiToUser[alias] = key;
      }
    }

    if (key.startsWith("gemini-") && key.includes("pro") && !isGeminiImageModel(key)) {
      const base = upstream.replace(/-(low|medium|high)$/, "");
      apiToUser[`${base}-low`] = key;
      apiToUser[`${base}-medium`] = key;
      apiToUser[`${base}-high`] = key;
    }

    if (key === "gemini-3.5-flash") {
      const base = upstream.replace(/-(minimal|low|medium|high)$/, "");
      for (const level of GEMINI_35_FLASH_LEVELS) {
        apiToUser[`${base}-${level}`] = key;
      }
    }
  }

  const userToApiBlock = Object.fromEntries(
    [...modelMap.entries()].filter(([key, upstream]) => key !== upstream)
  );

  updated = replaceConstRecord(updated, "USER_TO_API_MODEL_MAP", userToApiBlock);
  updated = replaceConstRecord(updated, "API_TO_USER_MODEL_MAP", apiToUser);

  if (updated !== source) {
    if (dryRun) {
      console.log("[antigravity] Would update quota.ts model maps");
    } else {
      writeFileSync(QUOTA_TS_PATH, updated);
      console.log("[antigravity] Updated quota.ts model maps");
    }
  } else {
    console.log("[antigravity] quota.ts already up to date.");
  }
}

function replaceConstRecord(source, constName, values) {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.length === 0
    ? ""
    : entries.map(([key, value]) => `  "${key}": "${value}",`).join("\n") + "\n";

  const replacement = `const ${constName}: Record<string, string> = {\n${body}};`;
  const regex = new RegExp(
    `const\\s+${escapeRegex(constName)}:\\s*Record<string, string>\\s*=\\s*\\{[\\s\\S]*?\\n\\};`
  );
  if (!regex.test(source)) {
    throw new Error(`Could not find ${constName} in quota.ts`);
  }
  return source.replace(regex, replacement);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  console.log("[antigravity] Fetching official Antigravity model docs ...");
  let markdown;
  try {
    markdown = await fetchText(ANTIGRAVITY_MODELS_URL, { label: "Antigravity model docs" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.warn(`[antigravity] Docs unavailable (404). Skipping sync — existing models preserved.`);
      return;
    }
    throw error;
  }

  const displayNames = parseReasoningModelNames(markdown);
  const { modelMap, discovered } = buildDiscoveredModelMap(displayNames);
  const documentedModelKeys = new Set(modelMap.keys());
  const extras = mergePreservedExtras(modelMap);
  const thinkingClaudeModelKeys = new Set(
    discovered
      .filter((entry) => entry.key.startsWith("claude-") && entry.thinking)
      .map((entry) => entry.key)
  );
  const providerConfigByModel = buildProviderConfigByModel(modelMap, thinkingClaudeModelKeys);

  console.log(
    `[antigravity] Found ${discovered.length} documented reasoning models ` +
      `and preserved ${extras.length} backend extras.`
  );

  if (verbose || dryRun) {
    console.log("\n[antigravity] Documented model mapping (display → canonical → upstream):");
    for (const entry of discovered) {
      const upstream = entry.key === entry.upstream ? entry.key : `${entry.key} → ${entry.upstream}`;
      console.log(`  ${entry.displayName} → ${upstream}`);
    }
    if (extras.length > 0) {
      console.log("\n[antigravity] Preserved backend extras:");
      for (const extra of extras) {
        console.log(`  ${extra.key}${extra.key !== extra.upstream ? ` → ${extra.upstream}` : ""}`);
      }
    }
    console.log();
  }

  const result = syncJson(modelMap, providerConfigByModel, dryRun);

  if (!dryRun && (result.added.length > 0 || result.updated.length > 0)) {
    enrichModelMetadata(result, documentedModelKeys);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `[antigravity] JSON models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `[antigravity] Synced ${modelMap.size} models ` +
        `(added: ${result.added.length}, removed: ${result.removed.length}, updated: ${result.updated.length}).`
    );
    if (result.added.length > 0) console.log(`  Added: ${result.added.join(", ")}`);
    if (result.removed.length > 0) console.log(`  Removed: ${result.removed.join(", ")}`);
    if (result.updated.length > 0) console.log(`  Updated: ${result.updated.join(", ")}`);
  }

  console.log();
  updateQuotaTs(modelMap, dryRun);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
