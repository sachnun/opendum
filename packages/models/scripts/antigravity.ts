#!/usr/bin/env node

/**
 * Antigravity refresh script.
 *
 * Fetches the public Google Antigravity model documentation and syncs the
 * reasoning models into the JSON model registry. The parser intentionally works
 * from display names instead of a fixed model table so new Gemini/Claude/GPT-OSS
 * versions can flow through without updating a hardcoded list.
 *
 * It also refreshes the User-Agent version used by the Go proxy and dashboard
 * Antigravity providers from the Antigravity changelog, so the hardcoded
 * version does not go stale between releases.
 *
 * Source: https://antigravity.google/docs/models
 *
 * Usage:
 *   node scripts/antigravity.ts
 *   node scripts/antigravity.ts --dry-run
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels, writeModelJson } from "../src/registry.ts";
import { fetchText } from "../src/http.ts";
import { stripParamInfoKey } from "../src/clean-key.ts";

const ANTIGRAVITY_MODELS_URL = "https://antigravity.google/docs/models";
const PROVIDER_NAME = "antigravity";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoRoot = resolve(packageDir, "../..");
const modelsDir = resolve(packageDir, "data");

const ANTIGRAVITY_VERSION_SOURCES = [
  "https://releasebot.io/updates/google/antigravity",
  "https://antigravity.google/changelog",
];
const VERSION_FETCH_TIMEOUT_MS = 15_000;

const PROXY_PROVIDER_PATH = resolve(
  repoRoot,
  "apps/proxy/internal/providers/google_code_assist.go"
);
const DASHBOARD_CONSTANTS_PATH = resolve(
  repoRoot,
  "apps/dashboard/server/lib/providers/antigravity/constants.ts"
);

const PROXY_USER_AGENT_REGEX =
  /((?:const\s+antigravityUserAgent\s*=\s*"antigravity\/))(\d+\.\d+\.\d+)(\s+")/;
const DASHBOARD_USER_AGENT_REGEX =
  /((?:export\s+)?const USER_AGENT\s*=\s*`antigravity\/)(\d+\.\d+\.\d+)(\s+linux\/amd64`;)/;

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
const GEMINI_3X_FLASH_LEVELS = ["low", "medium", "high"];
const GEMINI_31_PRO_LEVELS = ["low", "medium", "high"];

// Official docs expose user-facing labels, but cloudcode-pa v1internal can use
// backend IDs that are not derivable from the display name alone.
const DOCUMENTED_BACKEND_OVERRIDES = new Map([
  ["Claude Sonnet 4.6 (thinking)", { key: "claude-sonnet-4-6", upstream: "claude-sonnet-4-6" }],
  ["Claude Opus 4.6 (thinking)", { key: "claude-opus-4-6", upstream: "claude-opus-4-6-thinking" }],
  ["GPT-OSS-120b", { key: "gpt-oss-120b", upstream: "gpt-oss-120b-medium" }],
]);

const MODEL_ALIASES_BY_KEY = new Map([
  ["gemini-3.5-flash", GEMINI_35_FLASH_LEVELS.map((level) => `gemini-3.5-flash-${level}`)],
  ["gemini-3.1-pro", GEMINI_31_PRO_LEVELS.map((level) => `gemini-3.1-pro-${level}`)],
]);

function leveledFlashModelKey(modelKey) {
  const match = /^gemini-3\.(\d+)-flash$/.exec(modelKey);
  if (!match) return "";
  return Number(match[1]) >= 5 ? modelKey : "";
}

function leveledFlashUpstream(modelKey) {
  if (!leveledFlashModelKey(modelKey)) return "";
  const minor = Number(/^gemini-3\.(\d+)-flash$/.exec(modelKey)[1]);
  return minor >= 7 ? `${modelKey}-tiered` : `${modelKey}-medium`;
}

function leveledFlashAliases(modelKey) {
  if (!leveledFlashModelKey(modelKey)) return [];
  return GEMINI_3X_FLASH_LEVELS.map((level) => `${modelKey}-${level}`);
}

// Models can opt in/out by editing their JSON file directly. There is no
// longer a hard-coded preserved list here; a model's registry state is
// driven by the `providers` array on disk and the antigravity docs.

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

function htmlToReasoningModelMarkdown(html) {
  const sectionMatch = html.match(
    /<h2[^>]*id=["']reasoning-model["'][^>]*>[\s\S]*?<\/h2>\s*([\s\S]*?)(?:<h2[^>]*>|$)/i
  );
  if (!sectionMatch) {
    return "";
  }

  const tableMatch = sectionMatch[1].match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    return "";
  }

  const rows = [];
  const trMatches = tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const tr of trMatches) {
    const cells = [...tr[1].matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((m) => m[2].replace(/<[^>]+>/g, "").trim())
      .filter(Boolean);
    if (cells.length > 0) {
      rows.push(`| ${cells.join(" | ")} |`);
    }
  }

  return `## Reasoning Model\n\n${rows.join("\n")}\n`;
}

function parseReasoningModelNames(markdown) {
  const section = markdown.match(/## Reasoning Model\s+([\s\S]*?)(?:\n## |$)/);
  if (!section) {
    throw new Error("Could not find Reasoning Model section in Antigravity docs.");
  }

  const models = [];
  let pastHeader = false;
  for (const line of section[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || /^\|[\s:-]+\|/.test(trimmed)) continue;

    if (!pastHeader) {
      const firstCol = trimmed.match(/^\|\s+(.+?)\s+\|/);
      if (firstCol && /model/i.test(firstCol[1].trim())) continue;
      pastHeader = true;
    }

    const match = trimmed.match(/^\|\s+(.+?)\s+\|/);
    if (!match) continue;

    const name = stripMarkdown(match[1]).trim();
    if (!name) continue;

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

  return stripParamInfoKey(id);
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

  if (leveledFlashModelKey(entry.key)) {
    entry.upstream = leveledFlashUpstream(entry.key);
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

// Preserve any existing model file that already has the antigravity
// provider configured even when the model is not in the public docs.
// This keeps JSON the source of truth: edit providerConfig to a file
// to retain an antigravity binding across refresh runs.
function mergePreservedExtras(modelMap) {
  const index = buildModelIndex(modelsDir);
  const extras = [];

  for (const [key, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;
    if (modelMap.has(key)) continue;

    const upstream = getExistingProviderUpstream(entry, PROVIDER_NAME) || key;
    modelMap.set(key, upstream);
    extras.push({ key, upstream });
  }

  for (const [, entry] of Object.entries(index)) {
    const id = entry.id;
    if (!id || id === entry.fileId || modelMap.has(id)) continue;
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;

    const upstream = getExistingProviderUpstream(entry, PROVIDER_NAME) || id;
    modelMap.set(id, upstream);
    extras.push({ key: id, upstream });
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

    if (data.reasoning !== nextMeta.reasoning) {
      data.reasoning = nextMeta.reasoning;
      changed = true;
    }
    if (JSON.stringify(data.modalities) !== JSON.stringify(nextMeta.modalities)) {
      data.modalities = nextMeta.modalities;
      changed = true;
    }

    const desiredAliases = MODEL_ALIASES_BY_KEY.get(modelKey) || leveledFlashAliases(modelKey);
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
      modalities: {
        input: ["text", "image"],
        output: isGeminiImageModel(modelKey) ? ["image"] : ["text"],
      },
    };
  }
  if (modelKey.startsWith("claude-")) {
    return {
      reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    };
  }
  if (modelKey.startsWith("gpt-oss-")) {
    return {
      reasoning: true,
      modalities: { input: ["text"], output: ["text"] },
    };
  }
  return null;
}

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
      if (!existing) {
        // Don't propose adding antigravity to an existing model that is
        // ignored (e.g. an alias-only entry).
        const ignored = Object.values(index).find(
          (entry) =>
            entry.data.ignored &&
            (entry.fileId === key ||
              entry.id === key ||
              (entry.data.aliases || []).includes(key))
        );
        if (!ignored) {
          wouldAdd.push(key);
        }
        continue;
      }

      if (!(existing.data.providers || []).includes(PROVIDER_NAME)) {
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
  return { ...result, modelMap };
}

function parseLatestVersion(html) {
  const versionRegex = /\b(\d+\.\d+\.\d+)\b/g;
  const versions = [];
  let match;

  while ((match = versionRegex.exec(html)) !== null) {
    const version = match[1];
    if (version.startsWith("1.") && !version.startsWith("1.0")) {
      versions.push(version);
    }
  }

  if (versions.length === 0) {
    return null;
  }

  versions.sort((a, b) => {
    const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
    const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
    return bMajor - aMajor || bMinor - aMinor || bPatch - aPatch;
  });

  return versions[0];
}

function compareSemver(a, b) {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

function getCurrentVersion() {
  const source = readFileSync(PROXY_PROVIDER_PATH, "utf-8");
  const match = source.match(PROXY_USER_AGENT_REGEX);
  return match ? match[2] : null;
}

function updateVersion(newVersion) {
  for (const [filePath, regex] of [
    [PROXY_PROVIDER_PATH, PROXY_USER_AGENT_REGEX],
    [DASHBOARD_CONSTANTS_PATH, DASHBOARD_USER_AGENT_REGEX],
  ]) {
    const source = readFileSync(filePath, "utf-8");
    const updated = source.replace(regex, `$1${newVersion}$3`);
    writeFileSync(filePath, updated);
  }
}

async function syncUserAgent(dryRun) {
  const currentVersion = getCurrentVersion();
  if (!currentVersion) {
    console.warn("[antigravity] Could not find User-Agent version in Go proxy provider, skipping.");
    return;
  }

  console.log(`[antigravity] Current proxy User-Agent version is ${currentVersion}`);

  let latestVersion;
  for (const source of ANTIGRAVITY_VERSION_SOURCES) {
    try {
      const html = await fetchText(source, { label: source, timeout: VERSION_FETCH_TIMEOUT_MS, headers: { Accept: "text/html" } });
      latestVersion = parseLatestVersion(html);
      if (latestVersion) {
        console.log(`[antigravity] Latest version from ${source} is ${latestVersion}`);
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[antigravity] Fetch failed for ${source} (${message})`);
    }
  }

  if (!latestVersion) {
    console.warn("[antigravity] Could not parse version from any source, skipping.");
    return;
  }

  if (compareSemver(latestVersion, currentVersion) > 0) {
    if (dryRun) {
      console.log(`[antigravity] Would update User-Agent version ${currentVersion} -> ${latestVersion}`);
    } else {
      updateVersion(latestVersion);
      console.log(`[antigravity] Updated User-Agent version ${currentVersion} -> ${latestVersion}`);
    }
  } else {
    console.log("[antigravity] User-Agent version is already up to date.");
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  await syncUserAgent(dryRun).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[antigravity] User-Agent sync failed (${message})`);
  });

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

  const displayNames = parseReasoningModelNames(htmlToReasoningModelMarkdown(markdown));
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
      `and preserved ${extras.length} JSON-configured extras.`
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
