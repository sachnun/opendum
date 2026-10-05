import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, persistModel, syncProviderModels } from "#models/registry/registry.ts";
import { keyFromDocsId, leveledFlashAliases, type WidgetEntry } from "./antigravity-docs.ts";

const PROVIDER_NAME = "antigravity";
const ANTIGRAVITY_PAID_TIERS = ["g1-pro-tier", "g1-ultra-tier", "standard-tier", "paid"];

const libDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(libDir, "../..", "data");

type ModelIndex = ReturnType<typeof buildModelIndex>;
type IndexEntry = ModelIndex[string];
type SyncResult = { added: string[]; removed: string[]; updated: string[] };
type TierConfig = Map<string, { allowedTiers: string[] }>;

export function buildAntigravityTierConfig(
  modelMap: Map<string, string>,
  documentedModelKeys: Set<string>,
  widgetEntries: WidgetEntry[]
): TierConfig {
  const freeByKey = new Map<string, boolean>();
  for (const entry of widgetEntries) {
    const key = keyFromDocsId(entry.id);
    if (entry.tiers?.freeAndPlus === true) freeByKey.set(key, true);
    else if (!freeByKey.has(key)) freeByKey.set(key, false);
  }

  const config: TierConfig = new Map();
  for (const key of modelMap.keys()) {
    if (!documentedModelKeys.has(key)) continue;
    if (freeByKey.get(key) === true) continue;
    config.set(key, { allowedTiers: ANTIGRAVITY_PAID_TIERS });
  }
  return config;
}

function getExistingProviderUpstream(entry: IndexEntry, provider: string): string {
  const upstream = entry.data.providerConfig?.[provider]?.upstream;
  if (typeof upstream === "string" && upstream.trim() !== "") {
    return upstream.trim();
  }
  return entry.id || entry.fileId;
}

function findModelEntry(index: ModelIndex, modelKey: string): IndexEntry | null {
  const exact = Object.values(index).find((entry) => entry.fileId === modelKey || entry.id === modelKey);
  if (exact) return exact;

  return (
    Object.values(index).find((entry) => {
      if (entry.data.ignored) return false;
      return (entry.data.aliases || []).includes(modelKey);
    }) || null
  );
}

export function mergePreservedExtras(modelMap: Map<string, string>): Array<{ key: string; upstream: string }> {
  const index = buildModelIndex(modelsDir);
  const extras: Array<{ key: string; upstream: string }> = [];

  for (const [, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;
    const key = entry.fileId;
    if (modelMap.has(key)) continue;

    const upstream = getExistingProviderUpstream(entry, PROVIDER_NAME) || key;
    modelMap.set(key, upstream);
    extras.push({ key, upstream });
  }

  for (const [, entry] of Object.entries(index)) {
    const id = entry.id;
    if (!id || id === entry.fileId || modelMap.has(id)) continue;
    const providers = entry.data.providers || [];
    if (!providers.includes(PROVIDER_NAME)) continue;

    const upstream = getExistingProviderUpstream(entry, PROVIDER_NAME) || id;
    modelMap.set(id, upstream);
    extras.push({ key: id, upstream });
  }

  return extras;
}

function isGeminiImageModel(modelKey: string): boolean {
  return modelKey.includes("image");
}

function inferMetadata(
  modelKey: string
): { reasoning: boolean; modalities: { input: string[]; output: string[] } } | null {
  if (modelKey.startsWith("gemini-")) {
    return {
      reasoning: !isGeminiImageModel(modelKey),
      modalities: {
        input: ["text", "image"],
        output: isGeminiImageModel(modelKey) ? ["image"] : ["text"],
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

export function enrichModelMetadata(
  result: SyncResult,
  documentedModelKeys: Set<string>,
  aliasesByKey: Map<string, string[]>
): void {
  const index = buildModelIndex(modelsDir);
  const changedKeys = new Set([...result.added, ...result.updated]);

  for (const modelKey of changedKeys) {
    const entry = findModelEntry(index, modelKey);
    if (!entry) continue;

    const data = entry.data;
    let changed = false;
    if (documentedModelKeys.has(modelKey) && data.ignored) {
      delete data.ignored;
      changed = true;
    }

    const nextMeta = inferMetadata(modelKey);
    if (!nextMeta) {
      if (changed) persistModel(entry, data);
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

    const desiredAliases = aliasesByKey.get(modelKey) ?? leveledFlashAliases(modelKey);
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
      persistModel(entry, data);
    }
  }
}

export function syncJson(
  modelMap: Map<string, string>,
  dryRun: boolean,
  tierConfig: TierConfig
): SyncResult {
  if (dryRun) {
    console.log("[antigravity] Dry run - no JSON files modified.");

    const index = buildModelIndex(modelsDir);
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
      const existing = findModelEntry(index, key);
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

      const existingUpstream = getExistingProviderUpstream(existing, PROVIDER_NAME);
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

  return syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel: tierConfig,
    managedProviderConfigKeys: ["allowedTiers"],
  });
}
