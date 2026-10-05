import { resolveCanonicalFrom, type CanonicalIndex } from "#models/model/canonical.ts";
import { GENERATED_PROVIDER_FIELDS } from "#models/model/merge.ts";
import { modelProbeSets } from "#models/model/probes.ts";
import type { ModelData, ProviderModelConfig } from "#models/model/types.ts";

export interface CanonicalizationModel {
  relativeId: string;
  fileId: string;
  path: string;
  data: ModelData;
}

export interface CanonicalRename {
  kind: "rename";
  relativeId: string;
  fileId: string;
  path: string;
  from: string;
  to: string;
  tier: string;
  data: ModelData;
}

export interface CanonicalMerge {
  kind: "merge";
  relativeId: string;
  fileId: string;
  path: string;
  from: string;
  to: string;
  tier: string;
  data: ModelData;
  aliases: string[];
}

export type CanonicalAction = CanonicalRename | CanonicalMerge;

export interface CanonicalizationPlan {
  actions: CanonicalAction[];
  unresolved: string[];
  conflicts: string[];
}

function modelId(model: CanonicalizationModel): string {
  const id = typeof model.data.id === "string" ? model.data.id.trim() : "";
  return id || model.fileId;
}

function mergeProviderConfig(
  target: Record<string, ProviderModelConfig> | undefined,
  source: Record<string, ProviderModelConfig> | undefined,
): Record<string, ProviderModelConfig> {
  const merged: Record<string, ProviderModelConfig> = { ...(target ?? {}) };
  for (const [provider, config] of Object.entries(source ?? {})) {
    merged[provider] = { ...config, ...(merged[provider] ?? {}) };
  }
  return merged;
}

const FILL_FIELDS = [
  "reasoning",
  "reasoning_effort",
  "modalities",
  "limit",
  "cost",
  "scores",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unionInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (current === undefined) {
      target[key] = structuredClone(value);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(value)) {
      target[key] = [...new Set([...current, ...value])];
      continue;
    }
    if (isPlainObject(current) && isPlainObject(value)) unionInto(current, value);
  }
}

function fillMissing(target: ModelData, source: ModelData): void {
  const targetRecord = target as Record<string, unknown>;
  const sourceRecord = source as Record<string, unknown>;

  for (const field of FILL_FIELDS) {
    const incoming = sourceRecord[field];
    if (incoming === undefined) continue;

    const current = targetRecord[field];
    if (current === undefined) {
      targetRecord[field] = structuredClone(incoming);
      continue;
    }
    if (isPlainObject(current) && isPlainObject(incoming)) {
      unionInto(current, incoming);
      continue;
    }
    if (Array.isArray(current) && Array.isArray(incoming)) {
      targetRecord[field] = [...new Set([...current, ...incoming])];
    }
  }
}

export function authoredProviderConflict(target: ModelData, source: ModelData): string | null {
  for (const [provider, config] of Object.entries(source.providerConfig ?? {})) {
    const existing = target.providerConfig?.[provider];
    if (!existing) continue;
    for (const [key, value] of Object.entries(config)) {
      if (GENERATED_PROVIDER_FIELDS.has(key)) continue;
      const current = existing[key as keyof ProviderModelConfig];
      if (current === undefined) continue;
      if (JSON.stringify(current) !== JSON.stringify(value)) return `${provider}.${key}`;
    }
  }
  return null;
}

export function applyCanonicalMerge(target: ModelData, merge: CanonicalMerge): void {
  const source = merge.data;
  fillMissing(target, source);

  const providers = new Set([...(target.providers ?? []), ...(source.providers ?? [])]);
  target.providers = [...providers].sort();
  target.providerConfig = mergeProviderConfig(target.providerConfig, source.providerConfig);

  const aliases = new Set([...(target.aliases ?? []), ...merge.aliases]);
  aliases.delete(merge.to);
  target.aliases = [...aliases].sort();

  target.id = merge.to;
}

export function planCanonicalization(
  models: ReadonlyArray<CanonicalizationModel>,
  canonical: CanonicalIndex,
): CanonicalizationPlan {
  const byId = new Map<string, CanonicalizationModel>();
  for (const model of models) {
    const id = modelId(model);
    if (!byId.has(id)) byId.set(id, model);
  }

  const actions: CanonicalAction[] = [];
  const unresolved: string[] = [];
  const conflicts: string[] = [];
  const claimed = new Set<string>();
  const renames: CanonicalRename[] = [];
  const merges: CanonicalMerge[] = [];

  const ordered = [...models].sort((left, right) => modelId(left).localeCompare(modelId(right)));

  for (const model of ordered) {
    const from = modelId(model);
    const data = model.data;
    const probes = modelProbeSets({ id: modelId(model), fileId: model.fileId, data });

    const resolved = resolveCanonicalFrom(probes.core, canonical, { fallbackProbes: probes.aliases });
    if (!resolved) {
      unresolved.push(from);
      continue;
    }
    if (resolved.id === from) {
      claimed.add(from);
      continue;
    }

    const existing = byId.get(resolved.id);
    if (existing && existing !== model) {
      const conflict = authoredProviderConflict(existing.data, data);
      if (conflict) {
        conflicts.push(`${from} -> ${resolved.id} (${conflict})`);
        continue;
      }
      merges.push({
        kind: "merge",
        relativeId: model.relativeId,
        fileId: model.fileId,
        path: model.path,
        from,
        to: resolved.id,
        tier: resolved.tier,
        data,
        aliases: [...new Set([from, model.fileId, ...(data.aliases ?? [])])].filter(
          (alias) => alias && alias !== resolved.id,
        ),
      });
      claimed.add(resolved.id);
      continue;
    }

    if (claimed.has(resolved.id)) {
      const claimant = renames.find((rename) => rename.to === resolved.id);
      const conflict = claimant ? authoredProviderConflict(claimant.data, data) : null;
      if (conflict) {
        conflicts.push(`${from} -> ${resolved.id} (${conflict})`);
        continue;
      }
      merges.push({
        kind: "merge",
        relativeId: model.relativeId,
        fileId: model.fileId,
        path: model.path,
        from,
        to: resolved.id,
        tier: resolved.tier,
        data,
        aliases: [...new Set([from, model.fileId, ...(data.aliases ?? [])])].filter(
          (alias) => alias && alias !== resolved.id,
        ),
      });
      continue;
    }

    claimed.add(resolved.id);
    renames.push({
      kind: "rename",
      relativeId: model.relativeId,
      fileId: model.fileId,
      path: model.path,
      from,
      to: resolved.id,
      tier: resolved.tier,
      data,
    });
  }

  actions.push(...renames, ...merges);
  return { actions, unresolved, conflicts };
}
