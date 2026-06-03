#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "./model-registry.mjs";
import { sleep, fetchText, fetchJson, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "./lib/shared.mjs";

const OPENCODE_MODELS_URL = "https://unroxy.koyeb.app/opencode.ai/zen/v1/models";
const OPENCODE_ZEN_DOCS_URL = "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx";

function toModelKey(modelId) {
  if (modelId.endsWith("-free")) return modelId.slice(0, -"-free".length);
  return modelId;
}

function parseMarkdownTables(markdown) {
  const tables = [];
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i].trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[i + 1])) continue;

    const rows = [];
    for (let j = i; j < lines.length && lines[j].trim().startsWith("|"); j += 1) {
      rows.push(lines[j]);
      i = j;
    }

    const headers = splitMarkdownTableRow(rows[0]);
    const body = rows.slice(2).map((row) => splitMarkdownTableRow(row));
    tables.push({ headers, body });
  }

  return tables;
}

function splitMarkdownTableRow(row) {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/`/g, "").trim());
}

function headerIndex(headers, name) {
  return headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
}

function modelNameKey(name) {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractFreeModelIdsFromDocs(markdown) {
  const tables = parseMarkdownTables(markdown);
  const endpointsTable = tables.find((table) => headerIndex(table.headers, "Model ID") !== -1 && headerIndex(table.headers, "Endpoint") !== -1);
  const pricingTable = tables.find((table) => headerIndex(table.headers, "Input") !== -1 && headerIndex(table.headers, "Output") !== -1 && headerIndex(table.headers, "Cached Read") !== -1);

  if (!endpointsTable || !pricingTable) {
    throw new Error("Unexpected OpenCode Zen docs format: model endpoint or pricing table not found");
  }

  const endpointModelIndex = headerIndex(endpointsTable.headers, "Model");
  const endpointModelIDIndex = headerIndex(endpointsTable.headers, "Model ID");
  const pricingModelIndex = headerIndex(pricingTable.headers, "Model");
  const pricingInputIndex = headerIndex(pricingTable.headers, "Input");
  const pricingOutputIndex = headerIndex(pricingTable.headers, "Output");
  const pricingCachedReadIndex = headerIndex(pricingTable.headers, "Cached Read");
  const modelIdsByName = new Map();

  for (const row of endpointsTable.body) {
    const modelName = row[endpointModelIndex];
    const modelId = row[endpointModelIDIndex];
    if (modelName && modelId) modelIdsByName.set(modelNameKey(modelName), modelId);
  }

  const modelIds = [];
  for (const row of pricingTable.body) {
    const isFree = [row[pricingInputIndex], row[pricingOutputIndex], row[pricingCachedReadIndex]]
      .every((value) => value?.toLowerCase() === "free");
    if (!isFree) continue;

    const modelName = row[pricingModelIndex];
    const modelId = modelIdsByName.get(modelNameKey(modelName));
    if (!modelId) throw new Error(`OpenCode Zen docs pricing model is missing from endpoint table: ${modelName}`);
    modelIds.push(modelId);
  }

  if (modelIds.length === 0) {
    throw new Error("OpenCode Zen docs did not list any free models");
  }

  return modelIds.sort((a, b) => a.localeCompare(b));
}

async function fetchOpencodeFreeModelIds() {
  const [docsMarkdown, modelsPayload] = await Promise.all([
    fetchText(OPENCODE_ZEN_DOCS_URL, { label: "OpenCode Zen docs" }),
    fetchJson(OPENCODE_MODELS_URL, { label: "OpenCode model list" }),
  ]);

  if (!modelsPayload || !Array.isArray(modelsPayload.data)) {
    throw new Error("Unexpected Opencode /zen/v1/models payload format");
  }

  const availableModelIds = new Set(
    modelsPayload.data
      .map((model) => typeof model?.id === "string" ? model.id.trim() : "")
      .filter(Boolean),
  );
  const freeModelIds = extractFreeModelIdsFromDocs(docsMarkdown);
  const missingModelIds = freeModelIds.filter((id) => !availableModelIds.has(id));

  if (missingModelIds.length > 0) {
    throw new Error(`OpenCode Zen docs list free models missing from /zen/v1/models: ${missingModelIds.join(", ")}`);
  }

  return freeModelIds;
}

function buildModelMap(modelIds) {
  const map = new Map();

  for (const modelId of modelIds) {
    const modelKey = toModelKey(modelId);
    if (!map.has(modelKey)) {
      map.set(modelKey, modelId);
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const modelIds = await fetchOpencodeFreeModelIds();
  const modelMap = buildModelMap(modelIds);
  const result = syncProviderModels(modelsDir, "opencode", modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Opencode free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Opencode: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
