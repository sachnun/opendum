import { fetchJson } from "#models/lib/http.ts";
import { buildIndex, resolveCandidates, type IndexedModel } from "#models/model/similarity.ts";
import { MODELSDEV_CANONICAL_URL, buildCanonicalIndex } from "#models/model/canonical.ts";
import { PROVIDER_TO_MODELSDEV } from "#models/model/metadata-constants.ts";
import {
  asRecord,
  effortsFrom,
  firstDefined,
  hasProviderLimits,
  limitsFrom,
  mergeCosts,
  modalitiesFrom,
  pointsFrom,
  reasoningFrom,
} from "#models/model/metadata-helpers.ts";
import { SOURCES, groupByProvider } from "#models/model/metadata-sources.ts";
import type {
  ExternalCatalogs,
  ModelLimit,
  ModelMetadataInput,
  ModelMetadataPatch,
  ProviderLimits,
  Registries,
  RegistryName,
  ResolvedHit,
  ResolvedMetadata,
} from "#models/model/metadata-types.ts";

export {
  LITELLM_URL,
  MODELSDEV_URL,
  NVIDIA_MODELS_URL,
  OPENROUTER_MODELS_URL,
  POINTS_PER_USD,
  PROVIDER_TO_MODELSDEV,
} from "#models/model/metadata-constants.ts";
export type {
  ExternalCatalogs,
  Modalities,
  Modality,
  ModelCost,
  ModelLimit,
  ModelMetadataInput,
  ModelMetadataPatch,
  ProviderLimits,
  Registries,
  RegistryIndex,
  RegistryName,
  ResolvedHit,
  ResolvedMetadata,
} from "#models/model/metadata-types.ts";

export async function fetchExternalRegistries(
  options: { logger?: (message: string) => void } = {},
): Promise<ExternalCatalogs> {
  const logger = options.logger ?? (() => {});
  const registries: Registries = {};
  let canonicalModels: unknown;

  for (const source of SOURCES) {
    try {
      const payload = await fetchJson(source.url, { label: `external registry ${source.name}` });
      const entries = source.extract(payload);
      registries[source.name] = {
        entries,
        index: buildIndex(entries, source.name),
        byProvider: groupByProvider(entries, source.name),
      };
      if (source.name === "modelsdev") canonicalModels = payload;
      logger(`[metadata] ${source.name}: ${entries.length} entries`);
    } catch (error) {
      logger(`[metadata] ${source.name} unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let canonicalModelsJson: unknown;
  try {
    canonicalModelsJson = await fetchJson(MODELSDEV_CANONICAL_URL, { label: "models.dev canonical models" });
    const count = Object.keys(asRecord(canonicalModelsJson) ?? {}).length;
    logger(`[metadata] canonical models: ${count} entries`);
  } catch (error) {
    logger(`[metadata] canonical models unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  const canonical = buildCanonicalIndex({
    models: canonicalModelsJson,
    providers: canonicalModels,
    openrouter: registries.openrouter?.entries.map(
      (item) => (item as { entry?: unknown }).entry,
    ),
  });

  return { registries, canonical };
}

function pickHit<TEntry>(
  result: { exact: IndexedModel<TEntry> | null; match: IndexedModel<TEntry> | null },
): IndexedModel<TEntry> | null {
  return result.exact ?? result.match;
}

export function resolveModelMetadata(
  model: ModelMetadataInput,
  registries: Registries,
): ResolvedMetadata {
  const candidates = [...model.candidates].filter(Boolean);
  const providers = [...model.providers];
  const perProvider: Record<string, ResolvedHit> = {};

  for (const provider of providers) {
    const modelsdevId = PROVIDER_TO_MODELSDEV[provider];
    if (!modelsdevId) continue;
    const index = registries.modelsdev?.byProvider[modelsdevId];
    if (!index) continue;
    const hit = pickHit(resolveCandidates(candidates, index));
    if (hit) perProvider[provider] = { source: "modelsdev", id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  if (providers.includes("openrouter") && registries.openrouter) {
    const hit = pickHit(resolveCandidates(candidates, registries.openrouter.index));
    if (hit) perProvider.openrouter = { source: "openrouter", id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  if (providers.includes("nvidia_nim") && registries.nvidia) {
    const hit = pickHit(resolveCandidates(candidates, registries.nvidia.index));
    if (hit) perProvider.nvidia_nim = { source: "nvidia", id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  const global: Partial<Record<RegistryName, ResolvedHit>> = {};
  for (const name of ["modelsdev", "openrouter", "litellm"] as const) {
    const registry = registries[name];
    if (!registry) continue;
    const hit = pickHit(resolveCandidates(candidates, registry.index));
    if (hit) global[name] = { source: name, id: hit.id, entry: hit.entry, provider: hit.provider };
  }

  return { perProvider, global };
}

export function buildModelPatch(
  model: ModelMetadataInput,
  resolved: ResolvedMetadata,
): ModelMetadataPatch {
  const providerOrder = [...model.providers];
  const candidates: Array<ResolvedHit & { scope: "provider" | "global" }> = [];

  for (const provider of providerOrder) {
    const hit = resolved.perProvider[provider];
    if (hit) candidates.push({ ...hit, scope: "provider" });
  }
  for (const hit of Object.values(resolved.global)) {
    if (hit) candidates.push({ ...hit, scope: "global" });
  }

  const providerLimits: Record<string, ProviderLimits> = {};
  for (const [provider, hit] of Object.entries(resolved.perProvider)) {
    const limits = limitsFrom(hit.source, hit.entry);
    if (hasProviderLimits(limits)) providerLimits[provider] = limits;
  }

  const globalFallback = candidates.find((item) => item.scope === "global" && item.source === "modelsdev")
    ?? candidates.find((item) => item.scope === "global");
  for (const provider of providerOrder) {
    if (providerLimits[provider] || !globalFallback) continue;
    const limits = limitsFrom(globalFallback.source, globalFallback.entry);
    if (hasProviderLimits(limits)) providerLimits[provider] = limits;
  }

  const modalities = firstDefined(candidates.map((item) => modalitiesFrom(item.source, item.entry)));

  const reasoning = firstDefined(candidates.map((item) => reasoningFrom(item.source, item.entry)));

  const reasoningEffort = firstDefined(candidates.map((item) => effortsFrom(item.source, item.entry)));

  const cost = mergeCosts(candidates.map((item) => pointsFrom(item.source, item.entry)));

  const contexts = Object.values(providerLimits)
    .map((item) => item.contextWindow)
    .filter((value): value is number => typeof value === "number");
  const outputs = Object.values(providerLimits)
    .map((item) => item.maxOutputTokens)
    .filter((value): value is number => typeof value === "number");

  const limits: ModelLimit = {};
  if (contexts.length > 0) limits.context = Math.max(...contexts);
  if (outputs.length > 0) limits.output = Math.max(...outputs);

  return {
    reasoning,
    reasoningEffort,
    providerLimits,
    modalities,
    limits,
    cost,
    resolvedProviders: Object.keys(resolved.perProvider).length,
    minimumProviderContext: contexts.length > 0 ? Math.min(...contexts) : null,
    maximumProviderContext: contexts.length > 0 ? Math.max(...contexts) : null,
  };
}
