export type WidgetEntry = {
  id: string;
  name: string;
  tiers: Record<string, unknown>;
  defaultLevel: string;
  levels: string[];
};

export type DiscoveredModel = {
  displayName: string;
  key: string;
  upstream: string;
};

const GEMINI_3X_FLASH_LEVELS = ["low", "medium", "high"];

const DOCUMENTED_EFFORT_SUFFIX = new Map([
  ["claude-opus-4-6", "thinking"],
  ["claude-sonnet-4-6", ""],
  ["claude-opus-5-5", "medium"],
  ["claude-sonnet-5-5", "medium"],
  ["gpt-oss-120b", "medium"],
]);

export function leveledFlashModelKey(modelKey: string): string {
  const match = /^gemini-3\.(\d+)-flash$/.exec(modelKey);
  if (!match) return "";
  return Number(match[1]) >= 5 ? modelKey : "";
}

function leveledFlashUpstream(modelKey: string): string {
  if (!leveledFlashModelKey(modelKey)) return "";
  const minor = Number(/^gemini-3\.(\d+)-flash$/.exec(modelKey)?.[1] ?? 0);
  return minor >= 7 ? `${modelKey}-tiered` : `${modelKey}-medium`;
}

export function leveledFlashAliases(modelKey: string): string[] {
  if (!leveledFlashModelKey(modelKey)) return [];
  return GEMINI_3X_FLASH_LEVELS.map((level) => `${modelKey}-${level}`);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function parseModelSelectorWidget(html: string): WidgetEntry[] {
  const groupIndex = html.indexOf("model-selector-group");
  if (groupIndex < 0) {
    throw new Error(
      "Could not find the Antigravity model selector in the official docs. The page structure may have changed."
    );
  }

  const entries: WidgetEntry[] = [];
  for (const row of html.slice(groupIndex).split(/<div class="model-item-row/).slice(1)) {
    const id = row.match(/data-model-id="([^"]+)"/)?.[1];
    if (!id) continue;

    const name = decodeHtmlEntities(
      row.match(/<span class="model-name">([^<]*)<\/span>/)?.[1] ?? ""
    ).trim();
    const tiersRaw = decodeHtmlEntities(row.match(/data-tiers="([^"]*)"/)?.[1] ?? "");
    let tiers: Record<string, unknown>;
    try {
      tiers = JSON.parse(tiersRaw) as Record<string, unknown>;
    } catch {
      tiers = {};
    }

    const defaultLevel = decodeHtmlEntities(
      row.match(/data-level-display="[^"]*">([^<]*)</)?.[1] ?? ""
    ).trim();
    const levels = [...row.matchAll(/data-level-btn="([^"]+)"/g)].map((m) => m[1].trim());

    entries.push({ id, name, tiers, defaultLevel, levels });
    if (entries.length >= 50) break;
  }

  const unique = new Map<string, WidgetEntry>();
  for (const entry of entries) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry);
  }

  const models = [...unique.values()];
  if (models.length === 0) {
    throw new Error("No Antigravity models found in the official docs model selector.");
  }
  return models;
}

export function keyFromDocsId(id: string): string {
  if (id.startsWith("claude-")) return id.replace(/\.(?=\d)/g, "-");
  if (/^gemini-\d+(?:\.\d+)*-pro$/.test(id)) return `${id}-preview`;
  return id;
}

export function aliasesForWidgetEntry(entry: WidgetEntry): string[] {
  return entry.levels.map((level) => `${entry.id}-${level.toLowerCase()}`);
}

function canonicalizeWidgetModel(entry: WidgetEntry): DiscoveredModel {
  const key = keyFromDocsId(entry.id);
  let upstream: string;

  if (leveledFlashModelKey(key)) {
    upstream = leveledFlashUpstream(key);
  } else if (/^gemini-\d+(?:\.\d+)*-pro$/.test(entry.id)) {
    upstream = entry.id;
  } else {
    const suffix = DOCUMENTED_EFFORT_SUFFIX.get(key) ?? "";
    upstream = suffix ? `${key}-${suffix}` : key;
  }

  return { displayName: entry.name, key, upstream };
}

export function upstreamRank(upstream: string): number {
  if (/-high$/.test(upstream)) return 3;
  if (/-medium$/.test(upstream)) return 2;
  if (/-low$/.test(upstream)) return 1;
  return 0;
}

export function buildDiscoveredModelMap(widgetEntries: WidgetEntry[]): {
  modelMap: Map<string, string>;
  discovered: DiscoveredModel[];
} {
  const map = new Map<string, string>();
  const ranks = new Map<string, number>();
  const discovered: DiscoveredModel[] = [];

  for (const entry of widgetEntries) {
    const model = canonicalizeWidgetModel(entry);
    discovered.push(model);

    const rank = upstreamRank(model.upstream);
    if (!map.has(model.key) || rank > (ranks.get(model.key) ?? 0)) {
      map.set(model.key, model.upstream);
      ranks.set(model.key, rank);
    }
  }

  if (map.size === 0) {
    throw new Error("No Antigravity model IDs could be derived from official docs.");
  }

  return { modelMap: map, discovered };
}
