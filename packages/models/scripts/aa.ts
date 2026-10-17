#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAaIndex,
  decodeLeaderboardManifest,
  parseLeaderboard,
  parseLeaderboardManifest,
  resolveAaScore,
  type AaEntry,
} from "#models/sync/aa.ts";
import { modelProbes } from "#models/model/probes.ts";
import { runFetchText, request, runOrThrow } from "#models/sync/http.ts";
import { buildIndex, generatedPath, read, writeGenerated } from "#models/model-store.ts";

const LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
const USER_AGENT = "Mozilla/5.0 (compatible; opendum-model-sync)";
const MIN_EXPECTED_MODELS = 100;

async function fetchManifestModels(path: string, key: string): Promise<AaEntry[]> {
  const url = new URL(path, LEADERBOARD_URL).toString();
  const payload = await runOrThrow(
    request(url, { label: "Artificial Analysis manifest", headers: { "User-Agent": USER_AGENT } }, (response) =>
      response.arrayBuffer().then((buffer) => new Uint8Array(buffer)),
    ),
  );
  return decodeLeaderboardManifest(payload, key);
}

async function loadModels(): Promise<AaEntry[]> {
  const html = await runFetchText(LEADERBOARD_URL, {
    label: "Artificial Analysis leaderboard",
    headers: { "User-Agent": USER_AGENT },
  });
  const manifest = parseLeaderboardManifest(html);
  if (!manifest) return parseLeaderboard(html);

  const models = await fetchManifestModels(manifest.path, manifest.key);
  console.log(`[aa] manifest ${manifest.path} returned ${models.length} entries`);
  return models;
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");
  const dryRun = process.argv.includes("--dry-run");

  const models = await loadModels();
  if (models.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Artificial Analysis leaderboard returned ${models.length} scored models, expected at least ${MIN_EXPECTED_MODELS}`);
  }

  const index = buildAaIndex(models);
  console.log(`[aa] ${index.bySlug.size} slugs from ${models.length} entries`);

  const registry = buildIndex(modelsDir);
  let scored = 0;
  let updated = 0;
  let cleared = 0;
  const unmatched: string[] = [];

  for (const entry of Object.values(registry)) {
    if (entry.data.ignored) continue;
    const file = entry.generatedPath ?? generatedPath(entry.generatedDir, entry.relativeId);
    const hit = resolveAaScore(modelProbes(entry), index);
    if (!hit) {
      unmatched.push(entry.id);
      if (!entry.data.scores?.artificialAnalysis || !existsSync(file)) continue;
      const generated = read(readFileSync(file, "utf-8"));
      if (!generated.scores?.artificialAnalysis) continue;
      generated.scores = { ...generated.scores };
      delete generated.scores.artificialAnalysis;
      if (Object.keys(generated.scores).length === 0) delete generated.scores;
      cleared += 1;
      if (!dryRun) writeGenerated(file, generated);
      continue;
    }
    scored += 1;

    const next = {
      index: Math.round(hit.index * 10) / 10,
      estimated: hit.estimated,
    };
    const current = entry.data.scores?.artificialAnalysis;
    if (current?.index === next.index && current?.estimated === next.estimated) {
      continue;
    }

    const generated = existsSync(file)
      ? read(readFileSync(file, "utf-8"))
      : {};
    generated.scores = { artificialAnalysis: next };
    updated += 1;
    if (!dryRun) writeGenerated(file, generated);
  }

  console.log(`[aa] scored ${scored}/${Object.keys(registry).length}, updated ${updated}, cleared ${cleared}${dryRun ? " (dry run)" : ""}`);
  if (unmatched.length > 0) {
    console.log(`[aa] unscored (${unmatched.length}): ${unmatched.sort().join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
