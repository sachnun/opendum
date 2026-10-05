#!/usr/bin/env node

import { isDirectRun, runSourceCli } from "./cli.ts";
import type { ModelSource } from "./source.ts";


import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "#models/registry/registry.ts";
import { sleep, MAX_FETCH_ATTEMPTS, FETCH_TIMEOUT_MS } from "#models/lib/http.ts";
import { displayNameToKiroId, expandVariants, parseModelsFromHtml, toCanonical } from "./lib/kiro-parse.ts";

const KIRO_DOCS_URL = "https://kiro.dev/docs/models/";
const PROVIDER_NAME = "kiro";

function isIgnoredDisplayName(name) {
  return !/[0-9]/.test(name);
}

const PAID_KIRO_TIERS = ["pro", "pro+", "power", "standalone"];

async function fetchOfficialModels() {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(KIRO_DOCS_URL, {
        headers: {
          Accept: "text/html",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Kiro docs: ${response.status} ${response.statusText}`
        );
      }

      const html = await response.text();
      return parseModelsFromHtml(html);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        console.warn(
          `[kiro] Attempt ${attempt} failed: ${error.message}. Retrying...`
        );
        await sleep(attempt * 1_000);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to fetch Kiro models page");
}

async function fetchDocsCatalog() {
  let html;
  try {
    const response = await fetch(KIRO_DOCS_URL, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return new Map();
    html = await response.text();
  } catch {
    return new Map();
  }

  const chunkPaths = [
    ...new Set([...html.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9._-]+\.js/g)].map((m) => m[0])),
  ];
  const byName = new Map();

  for (const chunkPath of chunkPaths) {
    let script;
    try {
      const response = await fetch(new URL(chunkPath, KIRO_DOCS_URL), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      script = await response.text();
    } catch {
      continue;
    }

    for (const match of script.matchAll(/\{"id":"([a-z0-9.-]+)","name":"([^"]+)","provider":"[^"]+"/g)) {
      if (!byName.has(match[2])) byName.set(match[2], match[1]);
    }
  }

  return byName;
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");

  console.log(`[kiro] Fetching models from ${KIRO_DOCS_URL} ...`);
  const officialModels = await fetchOfficialModels();
  console.log(
    `[kiro] Found ${officialModels.length} models on docs page: ${officialModels.map((m) => m.name).join(", ")}`
  );

  const catalog = await fetchDocsCatalog();
  console.log(`[kiro] Resolved ${catalog.size} published model IDs from the docs bundle.`);

  const paidOnlyDisplayNames = new Set(
    officialModels
      .filter((m) => !isIgnoredDisplayName(m.name) && !m.freeAvailable && m.paidAvailable)
      .map((m) => m.name)
  );

  if (verbose || dryRun) {
    const freeModels = officialModels.filter((m) => !isIgnoredDisplayName(m.name) && m.freeAvailable);
    const paidModels = officialModels.filter((m) => paidOnlyDisplayNames.has(m.name));
    console.log(`\n[kiro] Tier breakdown:`);
    console.log(`  Free models (${freeModels.length}): ${freeModels.map((m) => m.name).join(", ")}`);
    console.log(`  Paid-only models (${paidModels.length}): ${paidModels.map((m) => m.name).join(", ")}`);
    console.log();
  }

  const allKiroIds = [];
  for (const model of officialModels) {
    if (isIgnoredDisplayName(model.name)) {
      if (verbose) {
        console.log(`[kiro] Skipping "${model.name}" (ignored)`);
      }
      continue;
    }

    const baseId = displayNameToKiroId(model.name, catalog);
    const variants = expandVariants(baseId);
    allKiroIds.push(...variants);

    if (verbose) {
      console.log(
        `[kiro]   "${model.name}" → ${variants.join(", ")}` +
          (model.region ? ` (${model.region})` : "")
      );
    }
  }

  console.log(`[kiro] Generated ${allKiroIds.length} Kiro API model IDs.`);

  const modelMap = new Map();
  for (const kiroId of allKiroIds) {
    const { key, upstream } = toCanonical(kiroId);
    modelMap.set(key, upstream);
  }

  console.log(`[kiro] Mapped to ${modelMap.size} canonical model keys.`);

  if (verbose || dryRun) {
    console.log("\n[kiro] Model mapping (canonical → upstream):");
    for (const [key, upstream] of [...modelMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}${key !== upstream ? ` → ${upstream}` : ""}`);
    }
    console.log();
  }

  const providerConfigByModel = new Map();
  for (const model of officialModels) {
    if (isIgnoredDisplayName(model.name)) continue;
    if (!paidOnlyDisplayNames.has(model.name)) continue;

    const baseId = displayNameToKiroId(model.name, catalog);
    const variants = expandVariants(baseId);
    for (const kiroId of variants) {
      const { key } = toCanonical(kiroId);
      providerConfigByModel.set(key, { allowedTiers: PAID_KIRO_TIERS });
    }
  }

  if (verbose || dryRun) {
    console.log("\n[kiro] Provider config by model (allowedTiers):");
    for (const [key, config] of [...providerConfigByModel.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}: allowedTiers = [${config.allowedTiers.join(", ")}]`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("[kiro] Dry run - no JSON files modified.");
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["allowedTiers"],
  });

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `[kiro] Models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `[kiro] Synced ${modelMap.size} models ` +
        `(added: ${result.added.length}, removed: ${result.removed.length}, updated: ${result.updated.length}).`
    );
    if (result.added.length > 0) {
      console.log(`  Added: ${result.added.join(", ")}`);
    }
    if (result.removed.length > 0) {
      console.log(`  Removed: ${result.removed.join(", ")}`);
    }
    if (result.updated.length > 0) {
      console.log(`  Updated: ${result.updated.join(", ")}`);
    }
  }
}


export const source: ModelSource = { name: "kiro", run };

if (isDirectRun(import.meta.url)) runSourceCli(source);
