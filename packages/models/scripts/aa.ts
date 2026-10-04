#!/usr/bin/env node

import { isDirectRun, runSourceCli } from "./cli.js";
import type { ModelSource } from "./source.js";

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAaIndex, parseLeaderboard, resolveAaScore } from "#models/registry/aa.ts";
import { modelProbes } from "#models/model/probes.ts";
import { fetchText } from "#models/lib/http.ts";
import { buildModelIndex, generatedModelPath, readModelJson, writeGeneratedModelJson } from "#models/registry/registry.ts";
import type { ModelData } from "#models/model/types.ts";

const LEADERBOARD_URL = "https://artificialanalysis.ai/leaderboards/models";
const USER_AGENT = "Mozilla/5.0 (compatible; opendum-model-sync)";
const MIN_EXPECTED_MODELS = 100;

async function run(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");
  const dryRun = process.argv.includes("--dry-run");

  const html = await fetchText(LEADERBOARD_URL, {
    label: "Artificial Analysis leaderboard",
    headers: { "User-Agent": USER_AGENT },
  });
  const { version, models } = parseLeaderboard(html);
  if (models.length < MIN_EXPECTED_MODELS) {
    throw new Error(`Artificial Analysis leaderboard returned ${models.length} scored models, expected at least ${MIN_EXPECTED_MODELS}`);
  }

  const index = buildAaIndex(models, version);
  console.log(`[aa] ${index.bySlug.size} slugs from ${models.length} entries, intelligence index v${version || "unknown"}`);

  const registry = buildModelIndex(modelsDir);
  let scored = 0;
  let updated = 0;
  let cleared = 0;
  const unmatched: string[] = [];

  for (const entry of Object.values(registry)) {
    if (entry.data.ignored) continue;
    const generatedPath = entry.generatedPath ?? generatedModelPath(entry.generatedDir, entry.relativeId);
    const hit = resolveAaScore(modelProbes(entry), index);
    if (!hit) {
      unmatched.push(entry.id);
      if (!entry.data.scores?.artificialAnalysis || !existsSync(generatedPath)) continue;
      const generated = readModelJson(readFileSync(generatedPath, "utf-8"));
      if (!generated.scores?.artificialAnalysis) continue;
      generated.scores = { ...generated.scores };
      delete generated.scores.artificialAnalysis;
      if (Object.keys(generated.scores).length === 0) delete generated.scores;
      cleared += 1;
      if (!dryRun) writeGeneratedModelJson(generatedPath, generated);
      continue;
    }
    scored += 1;

    const next = {
      index: Math.round(hit.index * 10) / 10,
      estimated: hit.estimated,
      version: version || undefined,
    };
    const current = entry.data.scores?.artificialAnalysis;
    if (
      current?.index === next.index
      && current?.estimated === next.estimated
      && (current?.version ?? "") === (next.version ?? "")
    ) {
      continue;
    }

    const generated = existsSync(generatedPath)
      ? readModelJson(readFileSync(generatedPath, "utf-8"))
      : {};
    generated.scores = { artificialAnalysis: next };
    updated += 1;
    if (!dryRun) writeGeneratedModelJson(generatedPath, generated);
  }

  console.log(`[aa] scored ${scored}/${Object.keys(registry).length}, updated ${updated}, cleared ${cleared}${dryRun ? " (dry run)" : ""}`);
  if (unmatched.length > 0) {
    console.log(`[aa] unscored (${unmatched.length}): ${unmatched.sort().join(", ")}`);
  }
}


export const source: ModelSource = { name: "aa", order: 1, run };

if (isDirectRun(import.meta.url)) runSourceCli(source);
