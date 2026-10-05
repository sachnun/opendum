import { MODEL_FAMILY_RANKING } from "./family-ranking.generated.ts";

type ModelFamilyRankingEntry = (typeof MODEL_FAMILY_RANKING)[number];
export type ModelFamily = ModelFamilyRankingEntry["name"] | "Others";

const FAMILY_BENCHMARK_SCORES: ReadonlyMap<string, number> = new Map(
  MODEL_FAMILY_RANKING.map((entry) => [entry.name, entry.score]),
);

const MODEL_FAMILY_ANCHOR_IDS: ReadonlyMap<string, string> = new Map(
  MODEL_FAMILY_RANKING.map((entry) => [entry.name, entry.anchorId]),
);

const FEATURED_SET: ReadonlySet<string> = new Set(MODEL_FAMILY_RANKING.map((entry) => entry.name));

function slugifyModelFamily(family: string): string {
  return family
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compareModelFamilies(a: string, b: string): number {
  const aScore = FAMILY_BENCHMARK_SCORES.get(a) ?? 0;
  const bScore = FAMILY_BENCHMARK_SCORES.get(b) ?? 0;
  if (aScore !== bScore) return bScore - aScore;
  return a.localeCompare(b);
}

export function getModelFamilyAnchorId(family: ModelFamily): string {
  if (family === "Others") return "other-models";
  return MODEL_FAMILY_ANCHOR_IDS.get(family) ?? `${slugifyModelFamily(family)}-models`;
}

export function categorizeModelFamily(family: string | undefined): ModelFamily {
  if (family && FEATURED_SET.has(family)) {
    return family;
  }

  return "Others";
}

const SORTED_FEATURED_FAMILIES: readonly string[] = [...MODEL_FAMILY_RANKING]
  .sort((a, b) => compareModelFamilies(a.name, b.name))
  .map((entry) => entry.name);

export const MODEL_FAMILY_SORT_ORDER: readonly ModelFamily[] = [
  ...SORTED_FEATURED_FAMILIES,
  "Others",
];

export const MODEL_FAMILY_NAV_ITEMS: Array<{ name: ModelFamily; anchorId: string }> = [
  ...SORTED_FEATURED_FAMILIES.map((name) => ({
    name,
    anchorId: getModelFamilyAnchorId(name),
  })),
  { name: "Others", anchorId: "other-models" },
];
