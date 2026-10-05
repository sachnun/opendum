#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { flagshipFamilyRanking, loadModelEntries } from "@opendum/models/runtime";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(scriptDir, "../../../packages/models/data");
const outputPath = resolve(scriptDir, "../shared/model/family-ranking.generated.ts");
const MIN_FLAGSHIP_SCORE = 20;

const ranking = flagshipFamilyRanking(loadModelEntries(dataDir))
  .filter((entry) => entry.score >= MIN_FLAGSHIP_SCORE)
  .map((entry) => ({
    name: entry.family,
    anchorId: `${entry.folder}-models`,
    score: entry.score,
  }));

const lines = ranking.map(
  (entry) =>
    `  { name: ${JSON.stringify(entry.name)}, anchorId: ${JSON.stringify(entry.anchorId)}, score: ${entry.score} },`,
);
const content = [
  "export type ModelFamilyRankingEntry = {",
  "  name: string;",
  "  anchorId: string;",
  "  score: number;",
  "};",
  "",
  "export const MODEL_FAMILY_RANKING: readonly ModelFamilyRankingEntry[] = [",
  ...lines,
  "];",
  "",
].join("\n");

writeFileSync(outputPath, content);
console.log(`[family-ranking] wrote ${ranking.length} families to ${outputPath}`);
