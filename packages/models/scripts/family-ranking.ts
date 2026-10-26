import { flagshipRanking, loadEntries } from "@opendum/models/runtime";
import { readText, writeText } from "#models/fs.ts";
import { join } from "#models/paths.ts";
import { dataDir, runScript } from "./shared.ts";

const MIN_FLAGSHIP_SCORE = 20;

interface FamilyRankingRow {
  name: string;
  anchorId: string;
  score: number;
}

function renderRanking(ranking: FamilyRankingRow[]): string {
  const lines = ranking.map(
    (entry) =>
      `  { name: ${JSON.stringify(entry.name)}, anchorId: ${JSON.stringify(entry.anchorId)}, score: ${entry.score} },`
  );

  return [
    "export type RankingEntry = {",
    "  name: string;",
    "  anchorId: string;",
    "  score: number;",
    "};",
    "",
    "export const MODEL_FAMILY_RANKING: readonly RankingEntry[] = [",
    ...lines,
    "];",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const modelsDir = dataDir();
  const outputPath = join(modelsDir, "..", "ranking.generated.ts");

  const ranking = flagshipRanking(loadEntries(modelsDir))
    .filter((entry) => entry.score >= MIN_FLAGSHIP_SCORE)
    .map((entry) => ({
      name: entry.family,
      anchorId: `${entry.folder}-models`,
      score: entry.score,
    }));

  const content = renderRanking(ranking);
  const previous = readText(outputPath);
  if (previous === content) {
    console.log(`[family-ranking] ${ranking.length} families already up to date`);
    return;
  }

  writeText(outputPath, content);
  console.log(`[family-ranking] wrote ${ranking.length} families to ${outputPath}`);
}

runScript(main);
