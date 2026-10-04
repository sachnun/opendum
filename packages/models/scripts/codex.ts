#!/usr/bin/env node

import { isDirectRun, runSourceCli } from "./cli.js";
import type { ModelSource } from "./source.js";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, persistModel, syncProviderModels } from "#models/registry.ts";
import { sleep, fetchText, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "#models/http.ts";

const CODEX_MODELS_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

// Codex's public models feed includes CLI/API variants that are not accepted by
// the ChatGPT-backed Codex account flow used by this project. Filter by
// visibility and supported_in_api; models that are still rejected by the
// ChatGPT Codex backend opt out with `"ignored": true` in their JSON file.
const CHATGPT_SUPPORTED_VISIBILITY = "list";

// Codex is included on the Free and Go plans with only a low-tier model, while
// the frontier models require a paid ChatGPT plan. The public models.json feed
// lists "free" for every model, so it cannot drive tier gating; the plan
// breakdown comes from the Codex pricing docs instead.
const CODEX_PRICING_DOCS_URL = "https://learn.chatgpt.com/docs/pricing.md";
const FREE_PLAN_NAMES = new Set(["Free", "Go"]);
const PAID_CODEX_TIERS = [
  "plus",
  "pro",
  "pro+",
  "business",
  "enterprise",
  "team",
  "student",
];

/**
 * Fetch the public models.json from the openai/codex GitHub repo.
 * Returns the parsed array of model entries.
 */
async function fetchCodexModels() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(CODEX_MODELS_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch models (${response.status} ${response.statusText})`
        );
      }

      const payload = await response.json();
      if (!payload || !Array.isArray(payload.models)) {
        throw new Error("Unexpected Codex models.json payload format");
      }

      return payload.models;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_FETCH_ATTEMPTS) {
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Codex CLI model list");
}

/**
 * Filter models that are visible and supported in API.
 */
function filterModels(models) {
  return models.filter((m) => {
    if (!m.slug || typeof m.slug !== "string") return false;
    if (m.visibility && m.visibility !== CHATGPT_SUPPORTED_VISIBILITY) return false;
    if (m.supported_in_api === false) return false;
    return true;
  });
}

/**
 * Build the modelKey -> upstreamName map.
 * For Codex the slug is already a clean key so modelKey === slug.
 */
function buildModelMap(models) {
  const map = new Map();

  for (const model of models) {
    map.set(model.slug, model.slug);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeModelName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Fetch the Codex pricing docs and join the model mentions from the Free/Go
 * plan cards. Any Codex model whose name is not mentioned there requires a paid
 * ChatGPT plan.
 */
async function fetchFreePlanModelNames() {
  const markdown = await fetchText(CODEX_PRICING_DOCS_URL, {
    label: "Codex pricing docs",
    headers: { Accept: "text/markdown" },
  });

  const mentions = [];
  for (const [, body] of markdown.matchAll(/<PricingCard([\s\S]*?)<\/PricingCard>/g)) {
    const name = (body.match(/name="([^"]+)"/) ?? [])[1] ?? "";
    if (!FREE_PLAN_NAMES.has(name)) continue;
    for (const line of body.split(/\r?\n/)) {
      const bullet = line.match(/^\s*-\s+(.*)$/);
      if (bullet) mentions.push(normalizeModelName(bullet[1]));
    }
  }

  return mentions.join(" ");
}

/**
 * Build per-model provider config with tier restrictions.
 *
 * Models not advertised on the Free/Go plan get `allowedTiers` restricted to
 * paid plans, which makes the web dim them for free-tier accounts (same pattern
 * as Kiro). If the docs cannot be read, no gating is applied.
 */
function buildProviderTierConfig(models, freePlanMentions) {
  const providerConfigByModel = new Map();
  if (!freePlanMentions) return providerConfigByModel;

  for (const model of models) {
    const name = normalizeModelName(model.display_name || model.slug);
    if (name && freePlanMentions.includes(name)) continue;
    providerConfigByModel.set(model.slug, { allowedTiers: PAID_CODEX_TIERS });
  }

  return providerConfigByModel;
}

/**
 * Build a lookup from slug -> models.json entry for enrichment.
 */
function buildMetadataLookup(models) {
  const lookup = new Map();
  for (const m of models) {
    if (m.slug) lookup.set(m.slug, m);
  }
  return lookup;
}

/**
 * After syncProviderModels creates bare-bones JSON files for new models,
 * enrich them with metadata from models.json.
 */
function enrichNewModels(modelsDir, addedKeys, metadataLookup) {
  const index = buildModelIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry) continue;

    const meta = metadataLookup.get(modelKey);
    if (!meta) continue;

    const data = entry.data;

    const hasReasoning =
      Array.isArray(meta.supported_reasoning_levels) &&
      meta.supported_reasoning_levels.length > 0;
    if (hasReasoning && data.reasoning !== true) {
      data.reasoning = true;
    }

    persistModel(entry, data);
  }
}

async function run() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const allModels = await fetchCodexModels();
  const filtered = filterModels(allModels);
  const modelMap = buildModelMap(filtered);
  const metadataLookup = buildMetadataLookup(filtered);

  let freePlanMentions = "";
  try {
    freePlanMentions = await fetchFreePlanModelNames();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex] Could not load pricing docs for tier gating (${message}); skipping gating.`);
  }

  const providerConfigByModel = buildProviderTierConfig(filtered, freePlanMentions);
  if (providerConfigByModel.size > 0) {
    console.log(`[codex] Paid-plan models (gated by allowedTiers): ${[...providerConfigByModel.keys()].join(", ")}`);
  }
  const result = syncProviderModels(modelsDir, "codex", modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["allowedTiers"],
  });

  if (result.added.length > 0) {
    enrichNewModels(modelsDir, result.added, metadataLookup);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `Codex CLI models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `Codex ChatGPT-compatible models: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}


export const source: ModelSource = { name: "codex", run };

if (isDirectRun(import.meta.url)) runSourceCli(source);
