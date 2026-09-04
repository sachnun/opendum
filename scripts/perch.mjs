#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { fetchText } from "./lib/shared.mjs";

const PROVIDER_NAME = "perch";

// Perch publishes the current Starter (free) pool on its models docs page
// (https://www.perchai.app/docs/concepts/models). That page is the live source
// of truth for which models a free account can pin; anything outside the
// Starter pool is Pro-only and paid, so it is intentionally never registered.
// The docs table only carries display names, so each name maps to the opendum
// canonical model id and the Perch pool alias used for the model-call pin.
const PERCH_DOCS_URL = "https://www.perchai.app/docs/concepts/models";

// Minimum number of Starter models expected; guards against silent breakage of
// the docs table extraction.
const MIN_EXPECTED_MODELS = 8;

const STARTER_POOL = new Map([
  ["Qwen 3.6", { canonical: "qwen3.6", alias: "qwen-3.6" }],
  ["Kimi K2.5", { canonical: "kimi-k2.5", alias: "kimi-2.5" }],
  ["GLM 5", { canonical: "glm-5", alias: "glm-5" }],
  ["Qwen3 Coder", { canonical: "qwen3-coder", alias: "qwen3-coder" }],
  ["Nemotron Super", { canonical: "nemotron-3-super", alias: "nemotron-super" }],
  ["MiniMax M2.7", { canonical: "minimax-m2.7", alias: "minimax-m2.7-free" }],
  ["MiniMax M3", { canonical: "minimax-m3", alias: "minimax-m3-free" }],
  ["Gemma 4 E2B", { canonical: "gemma-4-e2b", alias: "gemma-4-e2b" }],
  ["Gemma 4 31B", { canonical: "gemma-4-31b", alias: "gemma-4-31b" }],
]);

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractStarterPoolNames(html) {
  const sectionStart = html.indexOf("Starter pool and its published rates:");
  if (sectionStart === -1) {
    throw new Error("Unable to locate the Perch Starter pool table in the docs page");
  }
  const sectionEnd = html.indexOf("The premium models", sectionStart);
  const section = sectionEnd === -1 ? html.slice(sectionStart) : html.slice(sectionStart, sectionEnd);

  const names = new Set();
  const rowPattern = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  for (const match of section.matchAll(rowPattern)) {
    const name = decodeHtmlEntities(match[1].trim()).replace(/<[^>]+>/g, "").trim();
    if (name && !name.startsWith("$")) {
      names.add(name);
    }
  }
  return [...names];
}

async function fetchStarterPoolNames() {
  const html = await fetchText(PERCH_DOCS_URL, {
    label: "Perch models docs",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; opendum-model-sync)" },
  });
  const names = extractStarterPoolNames(html);
  if (names.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Expected at least ${MIN_EXPECTED_MODELS} Perch Starter model(s), got ${names.length}`);
  }
  return names;
}

function buildModelMap(docNames) {
  const modelMap = new Map();
  const unmapped = [];
  for (const docName of docNames) {
    const entry = STARTER_POOL.get(docName);
    if (!entry) {
      unmapped.push(docName);
      continue;
    }
    if (modelMap.has(entry.canonical) && modelMap.get(entry.canonical) !== entry.alias) {
      throw new Error(`Duplicate Perch Starter mapping for ${entry.canonical}`);
    }
    modelMap.set(entry.canonical, entry.alias);
  }
  if (unmapped.length > 0) {
    throw new Error(`Unmapped Perch Starter model(s): ${unmapped.join(", ")}. Add them to STARTER_POOL.`);
  }
  return new Map([...modelMap.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const docNames = await fetchStarterPoolNames();
  const modelMap = buildModelMap(docNames);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Perch Starter models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Perch: ${modelMap.size} Starter models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
