#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { fetchText } from "./lib/shared.mjs";

const PROVIDER_NAME = "harbor";
const HARBOR_MODELS_URL = "https://tokenharbor.ai/models";

function unescapeFlightPayload(html) {
  return html.replace(/\\"/g, '"');
}

function parseModelEntries(html) {
  const unescaped = unescapeFlightPayload(html);
  const entries = [];
  const seen = new Set();

  const pattern =
    /"surface":"([^"]+)".*?"isFree":(true|false),.*?"inputModalities":(\[[^\]]*\]),"outputModalities":(\[[^\]]*\])/g;

  for (const match of unescaped.matchAll(pattern)) {
    const [, surface, isFree, inputModalities] = match;
    if (seen.has(surface)) continue;
    seen.add(surface);
    entries.push({ surface, isFree: isFree === "true", inputModalities });
  }

  const fallbackPattern = /"surface":"([^"]+)"/g;
  for (const match of unescaped.matchAll(fallbackPattern)) {
    const surface = match[1];
    if (seen.has(surface)) continue;
    if (!surface.endsWith(":free")) continue;
    seen.add(surface);
    entries.push({ surface, isFree: true, inputModalities: null });
  }

  return entries;
}

function isFreeModel(entry) {
  if (entry.isFree) return true;
  return entry.surface.endsWith(":free");
}

function supportsTextOutput(entry) {
  if (!entry.inputModalities) return true;
  try {
    const modalities = JSON.parse(entry.inputModalities);
    return modalities.length === 0 || modalities.includes("text");
  } catch {
    return true;
  }
}

function toModelKey(modelId) {
  const modelKey = modelId
    .replace(/[:/]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-{2,}/g, "-");

  return modelKey.endsWith("-free") ? modelKey.slice(0, -"-free".length) : modelKey;
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    const baseModelKey = toModelKey(modelId);
    let modelKey = baseModelKey;
    let suffix = 2;

    while (map.has(modelKey) && map.get(modelKey) !== modelId) {
      modelKey = `${baseModelKey}-${suffix}`;
      suffix += 1;
    }

    map.set(modelKey, modelId);
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function fetchHarborFreeModelIds() {
  const html = await fetchText(HARBOR_MODELS_URL, { label: "Harbor /models catalog page" });
  const entries = parseModelEntries(html);

  const ids = entries
    .filter((entry) => isFreeModel(entry))
    .filter((entry) => supportsTextOutput(entry))
    .map((entry) => entry.surface.trim())
    .filter((id) => id.length > 0);

  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchHarborFreeModelIds();
  const modelMap = buildModelMap(modelIds);

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Harbor free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Harbor: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});