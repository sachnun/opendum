#!/usr/bin/env node

/**
 * Antigravity refresh script.
 *
 * Fetches the public Google Antigravity model documentation and syncs the
 * reasoning models into the JSON model registry. The model list, IDs and tier
 * availability come from the machine-readable model selector embedded in the
 * docs page (`data-model-id` / `data-tiers`), so new Gemini/Claude/GPT-OSS
 * versions flow through without updating a hardcoded list.
 *
 * It also refreshes the User-Agent version used by the Go proxy and web
 * Antigravity providers from the Antigravity changelog, so the hardcoded
 * version does not go stale between releases.
 *
 * Source: https://antigravity.google/docs/models
 *
 * Usage:
 *   node scripts/antigravity.ts
 *   node scripts/antigravity.ts --dry-run
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, persistModel, syncProviderModels } from "#models/model-store.ts";
import { runFetchText } from "#models/sync/http.ts";
import { syncCliVersion } from "./version-sync.ts";

const ANTIGRAVITY_MODELS_URL = "https://antigravity.google/docs/models";
const PROVIDER_NAME = "antigravity";

const ANTIGRAVITY_PAID_TIERS = ["g1-pro-tier", "g1-ultra-tier", "standard-tier", "paid"];

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const modelsDir = resolve(packageDir, "data");

// Antigravity publishes the same release notes as Markdown. This page is a
// stable, first party URL, unlike the auto updater bucket whose host embeds a
// numeric project id, so the emulated client version is read from here.
const ANTIGRAVITY_CHANGELOG_URL = "https://antigravity.google/docs/changelog.md";
// The desktop app section owns the version the providers emulate. Its release
// headings link to the `hub` release tab, which is a stabler anchor than the
// section title.
const ANTIGRAVITY_CHANGELOG_RELEASE_TAB = "hub";
const VERSION_FETCH_TIMEOUT_MS = 15_000;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Antigravity's emulated IDE version is reused by the provider and the quota
// fetcher, so both are refreshed together from the published release feed.
const ANTIGRAVITY_VERSION_TARGETS = [
  {
    label: "antigravity provider",
    path: resolve(REPO_ROOT, "packages/providers/upstreams/antigravity/index.ts"),
    pattern: /(antigravity\/)(\d+\.\d+\.\d+)( \$\{process\.platform\})/,
  },
  {
    label: "antigravity quota fetcher",
    path: resolve(REPO_ROOT, "packages/providers/quota/fetchers/antigravity.ts"),
    pattern: /(antigravity\/)(\d+\.\d+\.\d+)( \$\{process\.platform\})/,
  },
];

const GEMINI_3X_FLASH_LEVELS = ["low", "medium", "high"];

// cloudcode-pa appends an effort/reasoning SKU to the documented model ID.
// Gemini models derive it from their documented level; Claude and GPT-OSS use
// a fixed default SKU that the public docs do not list.
const DOCUMENTED_EFFORT_SUFFIX = new Map([
  ["claude-opus-4-6", "thinking"],
  ["claude-sonnet-4-6", ""],
  ["claude-opus-5-5", "medium"],
  ["claude-sonnet-5-5", "medium"],
  ["gpt-oss-120b", "medium"],
]);

const GEMINI_3X_FLASH_PATTERN = /^gemini-3\.(\d+)-flash$/;

// Documented Gemini models whose wire name carries an effort suffix. The docs
// picker exposes one level per model (e.g. Gemini 3.5 Flash, Gemini 4 Argon),
// so the registry stores the default wire and the provider appends the level.
function leveledGeminiModelKey(modelKey) {
  const flash = GEMINI_3X_FLASH_PATTERN.exec(modelKey);
  if (flash) return Number(flash[1]) >= 5 ? modelKey : "";
  return /^gemini-\d+-[a-z]+$/.test(modelKey) ? modelKey : "";
}

function leveledGeminiUpstream(modelKey) {
  if (!leveledGeminiModelKey(modelKey)) return "";
  const flash = GEMINI_3X_FLASH_PATTERN.exec(modelKey);
  if (flash) return Number(flash[1]) >= 7 ? `${modelKey}-tiered` : `${modelKey}-medium`;
  return `${modelKey}-medium`;
}

function leveledGeminiAliases(modelKey) {
  if (!leveledGeminiModelKey(modelKey)) return [];
  return GEMINI_3X_FLASH_LEVELS.map((level) => `${modelKey}-${level}`);
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Parse the model selector widget embedded in the Antigravity docs page.
 *
 * Each row carries the published model ID, display name, plan availability and
 * (for leveled models) the selectable reasoning levels.
 *
 * @param {string} html
 * @returns {Array<{ id: string, name: string, tiers: Record<string, boolean>, defaultLevel: string, levels: string[] }>}
 */
function parseModelSelectorWidget(html) {
  const groupIndex = html.indexOf("model-selector-group");
  if (groupIndex < 0) {
    throw new Error(
      "Could not find the Antigravity model selector in the official docs. The page structure may have changed."
    );
  }

  const entries = [];
  for (const row of html.slice(groupIndex).split(/<div class="model-item-row/).slice(1)) {
    const id = row.match(/data-model-id="([^"]+)"/)?.[1];
    if (!id) continue;

    const name = decodeHtmlEntities(
      row.match(/<span class="model-name">([^<]*)<\/span>/)?.[1] ?? ""
    ).trim();
    const tiersRaw = decodeHtmlEntities(row.match(/data-tiers="([^"]*)"/)?.[1] ?? "");
    let tiers = {};
    try {
      tiers = JSON.parse(tiersRaw);
    } catch {
      tiers = {};
    }

    const defaultLevel = decodeHtmlEntities(
      row.match(/data-level-display="[^"]*">([^<]*)</)?.[1] ?? ""
    ).trim();
    const levels = [...row.matchAll(/data-level-btn="([^"]+)"/g)].map((m) => m[1].trim());

    entries.push({ id, name, tiers, defaultLevel, levels });
    if (entries.length >= 50) break;
  }

  const unique = new Map();
  for (const entry of entries) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }

  const models = [...unique.values()];
  if (models.length === 0) {
    throw new Error("No Antigravity models found in the official docs model selector.");
  }
  return models;
}

function keyFromDocsId(id) {
  if (id.startsWith("claude-")) return id.replace(/\.(?=\d)/g, "-");
  if (/^gemini-\d+(?:\.\d+)*-pro$/.test(id)) return `${id}-preview`;
  return id;
}

function aliasesForWidgetEntry(entry) {
  return entry.levels.map((level) => `${entry.id}-${level.toLowerCase()}`);
}

function canonicalizeWidgetModel(entry) {
  const key = keyFromDocsId(entry.id);
  let upstream;

  if (leveledGeminiModelKey(key)) {
    upstream = leveledGeminiUpstream(key);
  } else if (/^gemini-\d+(?:\.\d+)*-pro$/.test(entry.id)) {
    upstream = entry.id;
  } else {
    const suffix = DOCUMENTED_EFFORT_SUFFIX.get(key) ?? "";
    upstream = suffix ? `${key}-${suffix}` : key;
  }

  return { displayName: entry.name, key, upstream };
}

function buildDiscoveredModelMap(widgetEntries) {
  const map = new Map();
  const ranks = new Map();
  const discovered = [];

  for (const entry of widgetEntries) {
    const model = canonicalizeWidgetModel(entry);
    discovered.push(model);

    const rank = upstreamRank(model.upstream);
    if (!map.has(model.key) || rank > (ranks.get(model.key) ?? 0)) {
      map.set(model.key, model.upstream);
      ranks.set(model.key, rank);
    }
  }

  if (map.size === 0) {
    throw new Error("No Antigravity model IDs could be derived from official docs.");
  }

  return { modelMap: map, discovered };
}

function upstreamRank(upstream) {
  if (upstream.endsWith("-high")) return 3;
  if (upstream.endsWith("-medium")) return 2;
  if (upstream.endsWith("-low")) return 1;
  return 0;
}

function buildAntigravityTierConfig(modelMap, documentedModelKeys, widgetEntries) {
  const freeByKey = new Map();
  for (const entry of widgetEntries) {
    const key = keyFromDocsId(entry.id);
    if (entry.tiers?.freeAndPlus === true) freeByKey.set(key, true);
    else if (!freeByKey.has(key)) freeByKey.set(key, false);
  }

  const config = new Map();
  for (const key of modelMap.keys()) {
    if (!documentedModelKeys.has(key)) continue;
    if (freeByKey.get(key) === true) continue;
    config.set(key, { allowedTiers: ANTIGRAVITY_PAID_TIERS });
  }
  return config;
}

// Preserve any existing model file that already has the antigravity
// provider configured even when the model is not in the public docs.
// This keeps JSON the source of truth: edit providerConfig to a file
// to retain an antigravity binding across refresh runs.
function mergePreservedExtras(modelMap) {
  const index = buildModelIndex(modelsDir);
  const extras = [];

  for (const [, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;
    const key = entry.fileId;
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

function isGeminiImageModel(modelKey) {
  return modelKey.includes("image");
}

function enrichModelMetadata(result, documentedModelKeys, aliasesByKey) {
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
      if (changed) persistModel(entry, data);
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

    const desiredAliases = aliasesByKey.get(modelKey) ?? leveledGeminiAliases(modelKey);
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
      persistModel(entry, data);
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

function syncJson(modelMap, dryRun, tierConfig) {
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

      const existingUpstream = getExistingProviderUpstream(existing, PROVIDER_NAME);
      if (existingUpstream !== upstream) {
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
    providerConfigByModel: tierConfig,
    managedProviderConfigKeys: ["allowedTiers"],
  });
}

/**
 * Read the newest desktop app version from the published changelog.
 *
 * Release headings look like `### [v2.23.0](/releases?tab=hub&version=2.23.0)`.
 * Matching the release tab keeps the CLI and IDE lines from being mistaken for
 * the desktop app version even if a section title is renamed.
 */
function parseLatestVersion(text, releaseTab) {
  const versions = [];
  for (const match of text.matchAll(/^###\s+\[v?(\d+\.\d+\.\d+)\]\(([^)]*)\)/gm)) {
    if (releaseTab && !match[2].includes(`tab=${releaseTab}`)) continue;
    versions.push(match[1]);
  }
  if (versions.length === 0) return null;

  return versions.sort(compareSemver).at(-1) ?? null;
}

function compareSemver(a, b) {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

async function syncUserAgent(dryRun) {
  let latestVersion = null;
  try {
    const text = await runFetchText(ANTIGRAVITY_CHANGELOG_URL, {
      label: "Antigravity changelog",
      timeout: VERSION_FETCH_TIMEOUT_MS,
      headers: { Accept: "text/markdown" },
    });
    latestVersion = parseLatestVersion(text, ANTIGRAVITY_CHANGELOG_RELEASE_TAB);
    if (latestVersion) {
      console.log(`[antigravity] Latest version from the changelog is ${latestVersion}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[antigravity] Fetch failed for the changelog (${message})`);
  }

  if (!latestVersion) {
    console.warn("[antigravity] Could not parse a version from the changelog, skipping.");
    return;
  }

  if (dryRun) {
    console.log(`[antigravity] Would sync CLI version to ${latestVersion}`);
    return;
  }
  syncCliVersion("antigravity", ANTIGRAVITY_VERSION_TARGETS, latestVersion);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  await syncUserAgent(dryRun).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[antigravity] User-Agent sync failed (${message})`);
  });

  console.log("[antigravity] Fetching official Antigravity model docs ...");
  let html;
  try {
    html = await runFetchText(ANTIGRAVITY_MODELS_URL, { label: "Antigravity model docs" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.warn(`[antigravity] Docs unavailable (404). Skipping sync — existing models preserved.`);
      return;
    }
    throw error;
  }

  const widgetEntries = parseModelSelectorWidget(html);
  const { modelMap, discovered } = buildDiscoveredModelMap(widgetEntries);
  const documentedModelKeys = new Set(modelMap.keys());
  const aliasesByKey = new Map(
    widgetEntries.map((entry) => [keyFromDocsId(entry.id), aliasesForWidgetEntry(entry)])
  );
  const extras = mergePreservedExtras(modelMap);
  const tierConfig = buildAntigravityTierConfig(modelMap, documentedModelKeys, widgetEntries);
  console.log(
    `[antigravity] Found ${discovered.length} documented reasoning models ` +
      `and preserved ${extras.length} JSON-configured extras.`
  );
  if (tierConfig.size > 0) {
    console.log(`[antigravity] Paid-only models (gated by allowedTiers): ${[...tierConfig.keys()].join(", ")}`);
  }

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

  const result = syncJson(modelMap, dryRun, tierConfig);

  if (!dryRun && (result.added.length > 0 || result.updated.length > 0)) {
    enrichModelMetadata(result, documentedModelKeys, aliasesByKey);
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
