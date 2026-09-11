#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildModelIndex, syncProviderModels, writeModelJson } from "./model-registry.mjs";
import { fetchJson } from "./lib/shared.mjs";

const PROVIDER_NAME = "workbuddy";
const WORKBUDDY_NPM_PACKAGE = "@tencent-ai/codebuddy-code";
const WORKBUDDY_PRODUCT_MEMBER = "package/product.json";

const MIN_EXPECTED_MODELS = 20;

const CODEBUDDY_ONLY_IDS = new Set([
  "default-model-lite",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gemini-3.1-pro",
  "gemini-3.0-flash",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.1-flash-lite",
  "deepseek-v3-2-volc",
  "glm-5.0",
  "kimi-k2.5",
  "minimax-m3",
]);

const WORKBUDDY_HOUSE_MODEL_IDS = new Set([
  "default-model",
  "fast-model",
  "balanced-model",
  "primary-model",
  "deep-model",
]);

const WORKBUDDY_ONLY_SUPPLEMENTS = new Map([
  ["deepseek-v4.1-flash", { reasoning: true, toolCall: true, vision: true }],
  ["gpt-6-astra", { reasoning: true, toolCall: true, vision: true }],
  ["hy4-preview", { reasoning: true, toolCall: true, vision: true }],
]);

function isExcludedId(id) {
  if (id.includes("image")) return true;
  if (id.startsWith("hunyuan-video")) return true;
  return CODEBUDDY_ONLY_IDS.has(id);
}

async function fetchWorkbuddyCatalog() {
  const metadata = await fetchJson(`https://registry.npmjs.org/${WORKBUDDY_NPM_PACKAGE}`, {
    label: `${WORKBUDDY_NPM_PACKAGE} npm metadata`,
  });
  const version = metadata?.["dist-tags"]?.latest;
  const tarball = metadata?.versions?.[version]?.dist?.tarball;
  if (typeof version !== "string" || typeof tarball !== "string") {
    throw new Error(`Unexpected ${WORKBUDDY_NPM_PACKAGE} npm metadata payload`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "workbuddy-"));
  try {
    const archivePath = join(tempDir, `${PROVIDER_NAME}-${version}.tgz`);
    const response = await fetch(tarball, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to download ${WORKBUDDY_NPM_PACKAGE} tarball (${response.status} ${response.statusText})`);
    }
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

    let source;
    try {
      source = execFileSync("tar", ["-xzO", "-f", archivePath, WORKBUDDY_PRODUCT_MEMBER], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Failed to extract ${WORKBUDDY_PRODUCT_MEMBER} from ${WORKBUDDY_NPM_PACKAGE}@${version}`);
    }

    let product;
    try {
      product = JSON.parse(source);
    } catch (error) {
      throw new Error(`Invalid ${WORKBUDDY_PRODUCT_MEMBER} JSON in ${WORKBUDDY_NPM_PACKAGE}@${version}`);
    }
    const models = product?.models;
    if (!Array.isArray(models) || models.length === 0) {
      throw new Error(`Unexpected models payload in ${WORKBUDDY_NPM_PACKAGE}@${version}`);
    }
    return models;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function readLocalCatalog() {
  const candidates = [join(homedir(), ".workbuddy-ai", "cache", "acc-product-config-v3.json")];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const payload = JSON.parse(readFileSync(candidate, "utf-8"));
      const models = Array.isArray(payload) ? payload : payload?.models;
      if (Array.isArray(models) && models.length > 0) return models;
    } catch {
      continue;
    }
  }
  return [];
}

function metaFromCatalogEntry(entry) {
  return {
    reasoning: entry?.supportsReasoning === true,
    toolCall: entry?.supportsToolCall === true,
    vision: entry?.supportsImages === true,
  };
}

function buildModelMap(catalog) {
  const modelMap = new Map();
  const metadataLookup = new Map();
  for (const entry of catalog) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id || isExcludedId(id)) continue;
    if (!modelMap.has(id)) {
      modelMap.set(id, id);
      metadataLookup.set(id, entry);
    }
  }

  for (const local of readLocalCatalog()) {
    const id = typeof local?.id === "string" ? local.id.trim() : "";
    if (!id || isExcludedId(id) || modelMap.has(id)) continue;
    modelMap.set(id, id);
    metadataLookup.set(id, local);
  }

  for (const id of WORKBUDDY_ONLY_SUPPLEMENTS.keys()) {
    if (!modelMap.has(id)) {
      modelMap.set(id, id);
    }
  }

  if (modelMap.size < MIN_EXPECTED_MODELS) {
    throw new Error(`Expected at least ${MIN_EXPECTED_MODELS} WorkBuddy models, got ${modelMap.size}`);
  }
  return { modelMap: new Map([...modelMap.entries()].sort(([a], [b]) => a.localeCompare(b))), metadataLookup };
}

function enrichNewModels(modelsDir, addedKeys, modelMap, metadataLookup) {
  const index = buildModelIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry) continue;

    const upstreamName = modelMap.get(modelKey);
    const catalogEntry = upstreamName ? metadataLookup.get(upstreamName) : null;
    const supplement = WORKBUDDY_ONLY_SUPPLEMENTS.get(modelKey);
    const meta = catalogEntry ? metaFromCatalogEntry(catalogEntry) : supplement;
    if (!meta) continue;

    const data = entry.data;
    if (!data.meta) data.meta = {};
    data.meta.reasoning = meta.reasoning;
    data.meta.toolCall = meta.toolCall;
    data.meta.vision = meta.vision;

    writeModelJson(entry.path, data);
  }
}

function enforceHouseIgnored(modelsDir) {
  const index = buildModelIndex(modelsDir);
  const changed = [];
  for (const modelKey of WORKBUDDY_HOUSE_MODEL_IDS) {
    const entry = Object.values(index).find((item) => item.fileId === modelKey || item.id === modelKey);
    if (!entry || entry.data.ignored === true) continue;
    const providers = entry.data.providers || [];
    if (providers.length > 0 && !providers.every((provider) => provider === PROVIDER_NAME)) continue;
    entry.data.ignored = true;
    writeModelJson(entry.path, entry.data);
    changed.push(modelKey);
  }
  return changed;
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const catalog = await fetchWorkbuddyCatalog();
  const { modelMap, metadataLookup } = buildModelMap(catalog);
  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);
  const ignored = enforceHouseIgnored(modelsDir);

  if (result.added.length > 0) {
    enrichNewModels(modelsDir, result.added, modelMap, metadataLookup);
  }

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0 && ignored.length === 0) {
    console.log(`WorkBuddy models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`WorkBuddy: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}, disabled ${ignored.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
