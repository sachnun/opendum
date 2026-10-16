import { compactStrings, uniqueSorted } from "./collections.ts";
import { inferFamilyFromFolder } from "./model/families.ts";
import type { ModelEntry, ModelInfo } from "./registry.ts";

export class Catalog {
  private readonly models = new Map<string, ModelInfo>();
  private readonly effective = new Map<string, ModelInfo>();
  private readonly ignoredIds = new Set<string>();

  private constructor() {}

  static fromEntries(entries: ModelEntry[], options: { familyFromFolder?: boolean } = {}): Catalog {
    const catalog = new Catalog();
    for (const entry of entries) {
      const info: ModelInfo = { ...entry.info };
      info.id = (info.id ?? "").trim();
      info.providers = compactStrings(info.providers);
      info.aliases = compactStrings(info.aliases);
      if (entry.owner) info.owner = entry.owner;
      if (options.familyFromFolder && !info.family && entry.owner) {
        info.family = inferFamilyFromFolder(entry.owner) ?? entry.owner;
      }
      const modelId = info.id ? info.id : entry.fileId;
      catalog.merge(modelId, entry.fileId, info);
      if (info.ignored) catalog.ignoredIds.add(modelId);
    }
    return catalog;
  }

  info(model: string): ModelInfo | null {
    return this.effective.get(model) ?? null;
  }

  canonicalIds(): Iterable<string> {
    return this.effective.keys();
  }

  entries(): Iterable<[string, ModelInfo]> {
    return this.effective.entries();
  }

  all(): string[] {
    return [...this.effective.entries()]
      .filter(([, info]) => info.providers.length > 0)
      .map(([model]) => model)
      .sort((a, b) => a.localeCompare(b));
  }

  families(): string[] {
    const families = new Set<string>();
    for (const info of this.effective.values()) {
      if (info.family) families.add(info.family);
    }
    return [...families].sort((a, b) => a.localeCompare(b));
  }

  ignoredModels(): string[] {
    return [...this.ignoredIds].sort((a, b) => a.localeCompare(b));
  }

  private merge(modelId: string, fileId: string, info: ModelInfo): void {
    if (!info.id) info.id = modelId;
    const aliases = [...(info.aliases ?? [])];
    if (fileId !== modelId) aliases.push(fileId);

    const existing = this.models.get(modelId);
    if (!existing) {
      const stored = { ...info, aliases: uniqueSorted(aliases) };
      this.models.set(modelId, stored);
      if (!stored.ignored) this.effective.set(modelId, stored);
      return;
    }

    const merged: ModelInfo = { ...existing };
    merged.id = modelId;
    merged.providers = uniqueSorted([...(existing.providers ?? []), ...(info.providers ?? [])]);
    merged.aliases = uniqueSorted([...(existing.aliases ?? []), ...aliases]);
    if (!merged.description) merged.description = info.description;
    if (!merged.family) merged.family = info.family;
    merged.ignored = Boolean(existing.ignored && info.ignored);
    if (merged.reasoning == null) merged.reasoning = info.reasoning;
    if (merged.reasoning_effort == null) merged.reasoning_effort = info.reasoning_effort;
    if (merged.modalities == null) merged.modalities = info.modalities;
    if (info.providerConfig && Object.keys(info.providerConfig).length > 0) {
      merged.providerConfig = { ...merged.providerConfig, ...info.providerConfig };
    }

    this.models.set(modelId, merged);
    if (!merged.ignored) this.effective.set(modelId, merged);
    else this.effective.delete(modelId);
  }
}
