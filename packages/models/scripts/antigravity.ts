import { buildIndex, persist, sync } from "#models/model-store.ts";
import { runFetchText } from "#models/sync/http.ts";
import { syncCli } from "./version-sync.ts";
import { join } from "#models/paths.ts";
import { flags, dataDir, repoRoot, runScript } from "./shared.ts";
import type { ModelIndexEntry, ModelModalities } from "#models/types.ts";

interface WidgetEntry {
  id: string;
  name: string;
  tiers: Record<string, unknown>;
  defaultLevel: string;
  levels: string[];
}

interface DiscoveredModel {
  displayName: string;
  key: string;
  upstream: string;
}

interface SyncResult {
  added: string[];
  removed: string[];
  updated: string[];
}

const ANTIGRAVITY_MODELS_URL = "https://antigravity.google/docs/models";
const PROVIDER_NAME = "antigravity";

const ANTIGRAVITY_PAID_TIERS = ["g1-pro-tier", "g1-ultra-tier", "standard-tier", "paid"];

const modelsDir = dataDir();

const ANTIGRAVITY_CHANGELOG_URL = "https://antigravity.google/docs/changelog.md";

const CHANGELOG_TAB = "hub";
const FETCH_TIMEOUT_MS = 15_000;

const REPO_ROOT = repoRoot();

const ANTIGRAVITY_VERSION_TARGETS = [
  {
    label: "antigravity provider",
    path: join(REPO_ROOT, "packages/providers/upstreams/antigravity/index.ts"),
    pattern: /(antigravity\/)(\d+\.\d+\.\d+)( \$\{process\.platform\})/,
  },
  {
    label: "antigravity quota fetcher",
    path: join(REPO_ROOT, "packages/providers/quota/fetchers/antigravity.ts"),
    pattern: /(antigravity\/)(\d+\.\d+\.\d+)( \$\{process\.platform\})/,
  },
];

const FLASH_LEVELS = ["low", "medium", "high"];

const DOCUMENTED_EFFORT_SUFFIX = new Map([
  ["claude-opus-4-6", "thinking"],
  ["claude-sonnet-4-6", ""],
  ["claude-opus-5-5", "medium"],
  ["claude-sonnet-5-5", "medium"],
  ["gpt-oss-120b", "medium"],
]);

const FLASH_PATTERN = /^gemini-3\.(\d+)-flash$/;

function leveledKey(modelKey: string): string {
  const flash = FLASH_PATTERN.exec(modelKey);
  if (flash) return Number(flash[1]) >= 5 ? modelKey : "";
  return /^gemini-\d+-[a-z]+$/.test(modelKey) ? modelKey : "";
}

function leveledUpstream(modelKey: string): string {
  if (!leveledKey(modelKey)) return "";
  const flash = FLASH_PATTERN.exec(modelKey);
  if (flash) return Number(flash[1]) >= 7 ? `${modelKey}-tiered` : `${modelKey}-medium`;
  return `${modelKey}-medium`;
}

function leveledAliases(modelKey: string): string[] {
  if (!leveledKey(modelKey)) return [];
  return FLASH_LEVELS.map((level) => `${modelKey}-${level}`);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseWidget(html: string): WidgetEntry[] {
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

    const name = decodeHtml(
      row.match(/<span class="model-name">([^<]*)<\/span>/)?.[1] ?? ""
    ).trim();
    const tiersRaw = decodeHtml(row.match(/data-tiers="([^"]*)"/)?.[1] ?? "");
    let tiers: Record<string, unknown> = {};
    try {
      tiers = JSON.parse(tiersRaw);
    } catch {
      tiers = {};
    }

    const defaultLevel = decodeHtml(
      row.match(/data-level-display="[^"]*">([^<]*)</)?.[1] ?? ""
    ).trim();
    const levels: string[] = [...row.matchAll(/data-level-btn="([^"]+)"/g)].map((m) => m[1].trim());

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

function keyOf(id: string): string {
  if (id.startsWith("claude-")) return id.replace(/\.(?=\d)/g, "-");
  if (/^gemini-\d+(?:\.\d+)*-pro$/.test(id)) return `${id}-preview`;
  return id;
}

function aliasesOf(entry: WidgetEntry): string[] {
  return entry.levels.map((level) => `${entry.id}-${level.toLowerCase()}`);
}

function canonicalize(entry: WidgetEntry): DiscoveredModel {
  const key = keyOf(entry.id);
  let upstream;

  if (leveledKey(key)) {
    upstream = leveledUpstream(key);
  } else if (/^gemini-\d+(?:\.\d+)*-pro$/.test(entry.id)) {
    upstream = entry.id;
  } else {
    const suffix = DOCUMENTED_EFFORT_SUFFIX.get(key) ?? "";
    upstream = suffix ? `${key}-${suffix}` : key;
  }

  return { displayName: entry.name, key, upstream };
}

function discoveredMap(widgetEntries: WidgetEntry[]): { modelMap: Map<string, string>; discovered: DiscoveredModel[] } {
  const map = new Map<string, string>();
  const ranks = new Map<string, number>();
  const discovered: DiscoveredModel[] = [];

  for (const entry of widgetEntries) {
    const model = canonicalize(entry);
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

function upstreamRank(upstream: string): number {
  if (upstream.endsWith("-high")) return 3;
  if (upstream.endsWith("-medium")) return 2;
  if (upstream.endsWith("-low")) return 1;
  return 0;
}

function tierMap(
  modelMap: Map<string, string>,
  documentedModelKeys: Set<string>,
  widgetEntries: WidgetEntry[]
): Map<string, { allowedTiers: string[] }> {
  const freeByKey = new Map<string, boolean>();
  for (const entry of widgetEntries) {
    const key = keyOf(entry.id);
    if (entry.tiers?.freeAndPlus === true) freeByKey.set(key, true);
    else if (!freeByKey.has(key)) freeByKey.set(key, false);
  }

  const config = new Map<string, { allowedTiers: string[] }>();
  for (const key of modelMap.keys()) {
    if (!documentedModelKeys.has(key)) continue;
    if (freeByKey.get(key) === true) continue;
    config.set(key, { allowedTiers: ANTIGRAVITY_PAID_TIERS });
  }
  return config;
}

function mergeExtras(modelMap: Map<string, string>): Array<{ key: string; upstream: string }> {
  const index = buildIndex(modelsDir);
  const extras: Array<{ key: string; upstream: string }> = [];

  for (const [, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;
    const key = entry.fileId;
    if (modelMap.has(key)) continue;

    const upstream = existingUpstream(entry, PROVIDER_NAME) || key;
    modelMap.set(key, upstream);
    extras.push({ key, upstream });
  }

  for (const [, entry] of Object.entries(index)) {
    const id = entry.id;
    if (!id || id === entry.fileId || modelMap.has(id)) continue;
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;

    const upstream = existingUpstream(entry, PROVIDER_NAME) || id;
    modelMap.set(id, upstream);
    extras.push({ key: id, upstream });
  }

  return extras;
}

function findEntry(index: Record<string, ModelIndexEntry>, modelKey: string): ModelIndexEntry | null {
  const exact = Object.values(index).find((entry) => entry.fileId === modelKey || entry.id === modelKey);
  if (exact) return exact;

  return Object.values(index).find((entry) => {
    if (entry.data.ignored) return false;
    return (entry.data.aliases || []).includes(modelKey);
  }) || null;
}

function existingUpstream(entry: ModelIndexEntry, provider: string): string {
  const upstream = entry.data.providerConfig?.[provider]?.upstream;
  if (typeof upstream === "string" && upstream.trim() !== "") {
    return upstream.trim();
  }
  return entry.id || entry.fileId;
}

function isImage(modelKey: string): boolean {
  return modelKey.includes("image");
}

async function enrichMetadata(
  result: SyncResult,
  documentedModelKeys: Set<string>,
  aliasesByKey: Map<string, string[]>
): Promise<void> {
  const index = buildIndex(modelsDir);
  const changedKeys = new Set([...result.added, ...result.updated]);

  for (const modelKey of changedKeys) {
    const entry = findEntry(index, modelKey);
    if (!entry) continue;

    const data = entry.data;
    let changed = false;
    if (documentedModelKeys.has(modelKey) && data.ignored) {
      delete data.ignored;
      changed = true;
    }

    const nextMeta = inferMetadata(modelKey);
    if (!nextMeta) {
      if (changed) persist(entry, data);
      continue;
    }

    if (data.reasoning !== nextMeta.reasoning) {
      data.reasoning = nextMeta.reasoning;
      changed = true;
    }
    if (JSON.stringify(data.modalities) !== JSON.stringify(nextMeta.modalities)) {
      data.modalities = nextMeta.modalities;
      changed = true;
    }

    const desiredAliases = aliasesByKey.get(modelKey) ?? leveledAliases(modelKey);
    if (desiredAliases.length > 0) {
      const aliases = new Set(data.aliases || []);
      for (const alias of desiredAliases) {
        aliases.add(alias);
      }
      const nextAliases = [...aliases].sort();
      if (JSON.stringify(data.aliases || []) !== JSON.stringify(nextAliases)) {
        data.aliases = nextAliases;
        changed = true;
      }
    }

    if (changed) {
      persist(entry, data);
    }
  }
}

function inferMetadata(modelKey: string): { reasoning: boolean; modalities: ModelModalities } | null {
  if (modelKey.startsWith("gemini-")) {
    return {
      reasoning: !isImage(modelKey),
      modalities: {
        input: ["text", "image"],
        output: isImage(modelKey) ? ["image"] : ["text"],
      },
    };
  }
  if (modelKey.startsWith("claude-")) {
    return {
      reasoning: true,
      modalities: { input: ["text", "image"], output: ["text"] },
    };
  }
  if (modelKey.startsWith("gpt-oss-")) {
    return {
      reasoning: true,
      modalities: { input: ["text"], output: ["text"] },
    };
  }
  return null;
}

async function syncJson(
  modelMap: Map<string, string>,
  dryRun: boolean,
  tierConfig: Map<string, { allowedTiers: string[] }>
): Promise<SyncResult> {
  if (dryRun) {
    console.log("[antigravity] Dry run - no JSON files modified.");

    const index = buildIndex(modelsDir);
    const wouldRemove: string[] = [];
    const wouldKeep: string[] = [];

    for (const [modelId, entry] of Object.entries(index)) {
      const publicId = entry.id || modelId;
      const providers = entry.data.providers || [];
      if (!providers.includes(PROVIDER_NAME)) continue;

      if (modelMap.has(modelId) || modelMap.has(publicId)) {
        wouldKeep.push(publicId);
      } else {
        wouldRemove.push(publicId);
      }
    }

    const wouldAdd: string[] = [];
    const wouldUpdate: string[] = [];
    for (const [key, upstream] of modelMap.entries()) {
      const existing = findEntry(index, key);
      if (!existing) {

        const ignored = Object.values(index).find(
          (entry) =>
            entry.data.ignored &&
            (entry.fileId === key ||
              entry.id === key ||
              (entry.data.aliases || []).includes(key))
        );
        if (!ignored) {
          wouldAdd.push(key);
        }
        continue;
      }

      if (!(existing.data.providers || []).includes(PROVIDER_NAME)) {
        wouldAdd.push(key);
        continue;
      }

      const existingUpstream = existingUpstream(existing, PROVIDER_NAME);
      if (existingUpstream !== upstream) {
        wouldUpdate.push(key);
      }
    }

    if (wouldRemove.length > 0) {
      console.log(`  Would REMOVE antigravity from: ${wouldRemove.join(", ")}`);
    }
    if (wouldAdd.length > 0) {
      console.log(`  Would ADD antigravity to: ${wouldAdd.join(", ")}`);
    }
    if (wouldUpdate.length > 0) {
      console.log(`  Would UPDATE antigravity config for: ${wouldUpdate.join(", ")}`);
    }
    if (wouldKeep.length > 0) {
      console.log(`  Would KEEP: ${wouldKeep.join(", ")}`);
    }

    return { added: wouldAdd, removed: wouldRemove, updated: wouldUpdate };
  }

  return await sync(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel: tierConfig,
    managedProviderConfigKeys: ["allowedTiers"],
  });
}

function latestRelease(text: string, releaseTab: string): string | null {
  const versions: string[] = [];
  for (const match of text.matchAll(/^###\s+\[v?(\d+\.\d+\.\d+)\]\(([^)]*)\)/gm)) {
    if (releaseTab && !match[2].includes(`tab=${releaseTab}`)) continue;
    versions.push(match[1]);
  }
  if (versions.length === 0) return null;

  return versions.sort(compareSemver).at(-1) ?? null;
}

function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);
  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1;
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1;
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1;
  return 0;
}

async function userAgent(dryRun: boolean): Promise<void> {
  let latestVersion = null;
  try {
    const text = await runFetchText(ANTIGRAVITY_CHANGELOG_URL, {
      label: "Antigravity changelog",
      timeout: FETCH_TIMEOUT_MS,
      headers: { Accept: "text/markdown" },
    });
    latestVersion = latestRelease(text, CHANGELOG_TAB);
    if (latestVersion) {
      console.log(`[antigravity] Latest version from the changelog is ${latestVersion}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[antigravity] Fetch failed for the changelog (${message})`);
  }

  if (!latestVersion) {
    console.warn("[antigravity] Could not parse a version from the changelog, skipping.");
    return;
  }

  if (dryRun) {
    console.log(`[antigravity] Would sync CLI version to ${latestVersion}`);
    return;
  }
  syncCli("antigravity", ANTIGRAVITY_VERSION_TARGETS, latestVersion);
}

async function main(): Promise<void> {
  const { dryRun, verbose } = flags();

  await userAgent(dryRun).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[antigravity] User-Agent sync failed (${message})`);
  });

  console.log("[antigravity] Fetching official Antigravity model docs ...");
  let html: string;
  try {
    html = await runFetchText(ANTIGRAVITY_MODELS_URL, { label: "Antigravity model docs" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.warn(`[antigravity] Docs unavailable (404). Skipping sync — existing models preserved.`);
      return;
    }
    throw error;
  }

  const widgetEntries = parseWidget(html);
  const { modelMap, discovered } = discoveredMap(widgetEntries);
  const documentedModelKeys = new Set(modelMap.keys());
  const aliasesByKey = new Map(
    widgetEntries.map((entry) => [keyOf(entry.id), aliasesOf(entry)])
  );
  const extras = mergeExtras(modelMap);
  const tierConfig = tierMap(modelMap, documentedModelKeys, widgetEntries);
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

  const result = await syncJson(modelMap, dryRun, tierConfig);

  if (!dryRun && (result.added.length > 0 || result.updated.length > 0)) {
    await enrichMetadata(result, documentedModelKeys, aliasesByKey);
  }

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `[antigravity] JSON models are already up to date (${modelMap.size} models).`
    );
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

runScript(main);
