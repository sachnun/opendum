#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { syncProviderModels } from "./model-registry.mjs";
import { fetchJson } from "./lib/shared.mjs";

const PROVIDER_NAME = "qoder";
const QODER_MODELS_PACKAGE = "opencode-qoder";
const QODER_MODELS_MEMBER = "package/dist/constants.js";
const QODER_MODELS_EXPORT = "QODER_MODELS";

const QODER_UPSTREAM_BY_CANONICAL = new Map([
  ["qwen3.7", "lite"],
  ["qwen3.7-plus", "qmodel"],
  ["qwen3.7-max", "qmodel_latest"],
  ["qwen3.8-max", "qmodel_preview"],
  ["deepseek-v4-pro", "dmodel"],
  ["deepseek-v4-flash", "dfmodel"],
  ["glm-5.2", "gm51model"],
  ["kimi-k2.7-code", "kmodel"],
  ["kimi-k3", "kmodel_latest"],
  ["minimax-m3", "mmodel"],
]);

const MIN_EXPECTED_UPSTREAM_KEYS = 8;

async function fetchQoderCatalog() {
  const metadata = await fetchJson(`https://registry.npmjs.org/${QODER_MODELS_PACKAGE}`, {
    label: `${QODER_MODELS_PACKAGE} npm metadata`,
  });
  const version = metadata?.["dist-tags"]?.latest;
  const tarball = metadata?.versions?.[version]?.dist?.tarball;
  if (typeof version !== "string" || typeof tarball !== "string") {
    throw new Error(`Unexpected ${QODER_MODELS_PACKAGE} npm metadata payload`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), `${QODER_MODELS_PACKAGE}-`));
  try {
    const archivePath = join(tempDir, `${QODER_MODELS_PACKAGE}-${version}.tgz`);
    const response = await fetch(tarball, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new Error(`Failed to download ${QODER_MODELS_PACKAGE} tarball (${response.status} ${response.statusText})`);
    }
    writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

    let source;
    try {
      source = execFileSync("tar", ["-xzO", "-f", archivePath, QODER_MODELS_MEMBER], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Failed to extract ${QODER_MODELS_MEMBER} from ${QODER_MODELS_PACKAGE}@${version}`);
    }
    if (!source.includes(QODER_MODELS_EXPORT)) {
      throw new Error(`${QODER_MODELS_EXPORT} export not found in ${QODER_MODELS_PACKAGE}@${version}`);
    }

    const modulePath = join(tempDir, "qoder-models.mjs");
    writeFileSync(modulePath, source);
    const mod = await import(pathToFileURL(modulePath).href);
    const catalog = mod[QODER_MODELS_EXPORT];
    if (!Array.isArray(catalog) || catalog.length === 0) {
      throw new Error(`Unexpected ${QODER_MODELS_EXPORT} payload in ${QODER_MODELS_PACKAGE}@${version}`);
    }
    return catalog;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildModelMap(catalog) {
  const upstreamKeys = new Set();
  for (const entry of catalog) {
    if (entry && typeof entry.id === "string" && entry.id.trim().length > 0) {
      upstreamKeys.add(entry.id.trim());
    }
  }

  const modelMap = new Map();
  for (const [canonicalKey, upstreamKey] of QODER_UPSTREAM_BY_CANONICAL) {
    if (upstreamKeys.has(upstreamKey)) {
      modelMap.set(canonicalKey, upstreamKey);
    }
  }

  if (modelMap.size < MIN_EXPECTED_UPSTREAM_KEYS) {
    throw new Error(`Expected at least ${MIN_EXPECTED_UPSTREAM_KEYS} Qoder upstream model keys, got ${modelMap.size}`);
  }
  return modelMap;
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../models");

  const catalog = await fetchQoderCatalog();
  const modelMap = buildModelMap(catalog);
  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Qoder models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Qoder: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
