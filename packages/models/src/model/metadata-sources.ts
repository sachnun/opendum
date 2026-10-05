import { buildIndex, type IndexedModel } from "#models/model/similarity.ts";
import {
  LITELLM_URL,
  MODELSDEV_URL,
  NVIDIA_MODELS_URL,
  OPENROUTER_MODELS_URL,
} from "#models/model/metadata-constants.ts";
import { asRecord } from "#models/model/metadata-helpers.ts";
import type { RegistryName } from "#models/model/metadata-types.ts";

export interface SourceExtractor {
  name: RegistryName;
  url: string;
  extract: (payload: unknown) => Array<{ id: string; name?: string; provider?: string; entry: unknown }>;
}

export const SOURCES: SourceExtractor[] = [
  {
    name: "openrouter",
    url: OPENROUTER_MODELS_URL,
    extract: (payload) => {
      const data = asRecord(payload)?.data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((item) => {
        const record = asRecord(item);
        const id = typeof record?.id === "string" ? record.id : "";
        if (!id) return [];
        return [{ id, name: typeof record?.name === "string" ? record.name : undefined, provider: "openrouter", entry: item }];
      });
    },
  },
  {
    name: "modelsdev",
    url: MODELSDEV_URL,
    extract: (payload) => {
      const providers = asRecord(payload);
      if (!providers) return [];
      return Object.entries(providers).flatMap(([providerId, provider]) => {
        const models = asRecord(asRecord(provider)?.models);
        if (!models) return [];
        return Object.entries(models).flatMap(([modelId, item]) => {
          const name = asRecord(item)?.name;
          return [{ id: modelId, name: typeof name === "string" ? name : undefined, provider: providerId, entry: item }];
        });
      });
    },
  },
  {
    name: "litellm",
    url: LITELLM_URL,
    extract: (payload) => {
      const entries = asRecord(payload);
      if (!entries) return [];
      return Object.entries(entries).map(([id, item]) => {
        const record = asRecord(item);
        const name = record?.name;
        const provider = record?.litellm_provider;
        return {
          id,
          name: typeof name === "string" ? name : id,
          provider: typeof provider === "string" ? provider : undefined,
          entry: item,
        };
      });
    },
  },
  {
    name: "nvidia",
    url: NVIDIA_MODELS_URL,
    extract: (payload) => {
      const data = asRecord(payload)?.data;
      if (!Array.isArray(data)) return [];
      return data.flatMap((item) => {
        const record = asRecord(item);
        const id = typeof record?.id === "string" ? record.id : "";
        if (!id) return [];
        const ownedBy = record?.owned_by;
        return [{ id, name: id, provider: typeof ownedBy === "string" ? ownedBy : undefined, entry: item }];
      });
    },
  },
];

export function groupByProvider(
  entries: ReadonlyArray<{ id: string; name?: string; provider?: string; entry: unknown }>,
  source: string,
): Record<string, Map<string, IndexedModel<unknown>>> {
  const groups: Record<string, Array<{ id: string; name?: string; provider?: string; entry: unknown }>> = {};
  for (const item of entries) {
    if (!item.provider) continue;
    groups[item.provider] ??= [];
    groups[item.provider]!.push(item);
  }

  const result: Record<string, Map<string, IndexedModel<unknown>>> = {};
  for (const [providerId, items] of Object.entries(groups)) {
    result[providerId] = buildIndex(items, source);
  }
  return result;
}
