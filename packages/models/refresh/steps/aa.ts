import { Effect } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";

import {
  aaIndex,
  parseLeaderboard,
  parseManifest,
  aaScore,
  tryDecode,
  type AaEntry,
} from "@opendum/models/sync/aa";
import { modelProbes } from "@opendum/models/model/probes";
import { fetchBytes, fetchText, orThrow } from "@opendum/models/sync/http";
import { buildIndex, generatedPath, read, writeGenerated } from "@opendum/models/model-store";
import { exists, readText } from "@opendum/models/fs";
import { dataDir } from "@opendum/models/refresh/core/env";
import type { ModelData } from "@opendum/models/types";

const LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
const USER_AGENT = "Mozilla/5.0 (compatible; opendum-model-sync)";
const MIN_EXPECTED_MODELS = 100;

function manifestModels(path: string, key: string): Effect.Effect<AaEntry[], Error> {
  const url = new URL(path, LEADERBOARD_URL).toString();
  return Effect.gen(function* () {
    const payload = yield* fetchBytes(url, {
      label: "Artificial Analysis manifest",
      headers: { "User-Agent": USER_AGENT },
    });
    return yield* tryDecode(payload, key);
  });
}

async function loadModels(): Promise<AaEntry[]> {
  const html = await orThrow(
    fetchText(LEADERBOARD_URL, {
      label: "Artificial Analysis leaderboard",
      headers: { "User-Agent": USER_AGENT },
    })
  );
  const manifest = parseManifest(html);
  if (!manifest) return parseLeaderboard(html);

  const models = await orThrow(manifestModels(manifest.path, manifest.key));
  console.log(`[aa] manifest ${manifest.path} returned ${models.length} entries`);
  return models;
}

async function main(): Promise<void> {
  const modelsDir = dataDir();
  const dryRun = process.argv.includes("--dry-run");

  const models = await loadModels();
  if (models.length < MIN_EXPECTED_MODELS) {
    raise(
      new Error(
        `Artificial Analysis leaderboard returned ${models.length} scored models, expected at least ${MIN_EXPECTED_MODELS}`
      )
    );
  }

  const index = aaIndex(models);
  console.log(`[aa] ${index.bySlug.size} slugs from ${models.length} entries`);

  const registry = buildIndex(modelsDir);
  let scored = 0;
  let updated = 0;
  let cleared = 0;
  const unmatched: string[] = [];

  for (const entry of Object.values(registry)) {
    if (entry.data.ignored) continue;
    const file = entry.generatedPath ?? generatedPath(entry.generatedDir, entry.relativeId);
    const hit = aaScore(modelProbes(entry), index);
    if (!hit) {
      unmatched.push(entry.id);
      if (!entry.data.scores?.artificialAnalysis || !exists(file)) continue;
      const generated = read(readText(file));
      if (!generated.scores?.artificialAnalysis) continue;
      generated.scores = { ...generated.scores };
      delete generated.scores.artificialAnalysis;
      if (Object.keys(generated.scores).length === 0) delete generated.scores;
      cleared += 1;
      if (!dryRun) await writeGenerated(file, generated);
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

    const generated = exists(file) ? read(readText(file)) : ({} as ModelData);
    generated.scores = { artificialAnalysis: next };
    updated += 1;
    if (!dryRun) await writeGenerated(file, generated);
  }

  console.log(
    `[aa] scored ${scored}/${Object.keys(registry).length}, updated ${updated}, cleared ${cleared}${dryRun ? " (dry run)" : ""}`
  );
  if (unmatched.length > 0) {
    console.log(`[aa] unscored (${unmatched.length}): ${unmatched.sort().join(", ")}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
