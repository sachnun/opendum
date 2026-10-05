#!/usr/bin/env node

import { isDirectRun, runSourceCli } from "./cli.ts";
import type { ModelSource } from "./source.ts";

import { fetchText } from "#models/lib/http.ts";
import {
  aliasesForWidgetEntry,
  buildDiscoveredModelMap,
  keyFromDocsId,
  parseModelSelectorWidget,
} from "./lib/antigravity-docs.ts";
import {
  buildAntigravityTierConfig,
  enrichModelMetadata,
  mergePreservedExtras,
  syncJson,
} from "./lib/antigravity-sync.ts";
import { syncUserAgent } from "./lib/antigravity-version.ts";

const ANTIGRAVITY_MODELS_URL = "https://antigravity.google/docs/models";

async function run(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");

  await syncUserAgent(dryRun).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[antigravity] User-Agent sync failed (${message})`);
  });

  console.log("[antigravity] Fetching official Antigravity model docs ...");
  let html: string;
  try {
    html = await fetchText(ANTIGRAVITY_MODELS_URL, { label: "Antigravity model docs" });
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

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`[antigravity] JSON models are already up to date (${modelMap.size} models).`);
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

export const source: ModelSource = { name: "antigravity", run };

if (isDirectRun(import.meta.url)) runSourceCli(source);
