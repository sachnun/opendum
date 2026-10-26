import { MODEL_FAMILY_RANKING } from "./ranking.generated.ts";

type RankingEntry = (typeof MODEL_FAMILY_RANKING)[number];
export type ModelFamily = RankingEntry["name"] | "Others";

const FAMILY_BENCHMARK_SCORES: ReadonlyMap<string, number> = new Map(
  MODEL_FAMILY_RANKING.map((entry) => [entry.name, entry.score]),
);

const ANCHOR_IDS: ReadonlyMap<string, string> = new Map(
  MODEL_FAMILY_RANKING.map((entry) => [entry.name, entry.anchorId]),
);

const FEATURED_SET: ReadonlySet<string> = new Set(MODEL_FAMILY_RANKING.map((entry) => entry.name));

function slugifyFamily(family: string): string {
  return family
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compareFamilies(a: string, b: string): number {
  const aScore = FAMILY_BENCHMARK_SCORES.get(a) ?? 0;
  const bScore = FAMILY_BENCHMARK_SCORES.get(b) ?? 0;
  if (aScore !== bScore) return bScore - aScore;
  return a.localeCompare(b);
}

export function anchorId(family: ModelFamily): string {
  if (family === "Others") return "other-models";
  return ANCHOR_IDS.get(family) ?? `${slugifyFamily(family)}-models`;
}

export function categorize(family: string | undefined): ModelFamily {
  if (family && FEATURED_SET.has(family)) {
    return family;
  }

  return "Others";
}

const SORTED_FEATURED_FAMILIES: readonly string[] = [...MODEL_FAMILY_RANKING]
  .sort((a, b) => compareFamilies(a.name, b.name))
  .map((entry) => entry.name);

export const SORT_ORDER: readonly ModelFamily[] = [
  ...SORTED_FEATURED_FAMILIES,
  "Others",
];

export const NAV_ITEMS: Array<{ name: ModelFamily; anchorId: string }> = [
  ...SORTED_FEATURED_FAMILIES.map((name) => ({
    name,
    anchorId: anchorId(name),
  })),
  { name: "Others", anchorId: "other-models" },
];
