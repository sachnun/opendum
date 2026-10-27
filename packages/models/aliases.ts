import { uniqueSorted } from "@opendum/models/collections";
import type { ModelInfo } from "@opendum/models/registry";
import { compareText } from "@opendum/models/compare";

export function nvidiaAlias(upstream: string): string {
  const stripped = upstream.startsWith("library/") ? upstream.slice("library/".length) : upstream;
  const replaced = stripped.replace(/[:/]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-");
  return replaced.replace(/-{2,}/g, "-");
}

export type AliasSource = {
  canonicalIds(): Iterable<string>;
  info(model: string): ModelInfo | null;
};

export class Aliases {
  private readonly aliasToCanonical = new Map<string, string>();
  private readonly foldedAliases = new Map<string, string>();
  private readonly canonicalToAliases = new Map<string, string[]>();

  private constructor() {}

  static build(source: AliasSource): Aliases {
    const index = new Aliases();
    const canonicals = [...source.canonicalIds()].sort((a, b) => compareText(a, b));

    for (const canonical of canonicals) index.aliasToCanonical.set(canonical, canonical);
    for (const canonical of canonicals) {
      const info = source.info(canonical);
      if (!info) continue;
      if (info.id && info.id !== canonical) index.assign(info.id, canonical, source);
      for (const alias of info.aliases ?? []) index.assign(alias, canonical, source);
    }

    const upstreamNames = new Map<string, string>();
    for (const canonical of canonicals) {
      const info = source.info(canonical);
      if (!info) continue;
      const providers = Object.keys(info.providerConfig ?? {}).sort((a, b) => compareText(a, b));
      for (const provider of providers) {
        const upstream = (info.providerConfig?.[provider]?.upstream ?? "").trim();
        if (!upstream || upstreamNames.has(upstream)) continue;
        upstreamNames.set(upstream, canonical);
      }
    }
    for (const upstreamName of [...upstreamNames.keys()].sort((a, b) => compareText(a, b))) {
      const canonical = upstreamNames.get(upstreamName) as string;
      if (!index.aliasToCanonical.has(upstreamName)) index.aliasToCanonical.set(upstreamName, canonical);
      const legacy = nvidiaAlias(upstreamName);
      if (legacy !== upstreamName && !index.aliasToCanonical.has(legacy)) {
        index.aliasToCanonical.set(legacy, canonical);
      }
    }

    for (const alias of [...index.aliasToCanonical.keys()].sort((a, b) => compareText(a, b))) {
      const canonical = index.aliasToCanonical.get(alias) as string;
      if (alias === canonical) continue;
      const list = index.canonicalToAliases.get(canonical) ?? [];
      list.push(alias);
      index.canonicalToAliases.set(canonical, list);
    }
    for (const [canonical, aliases] of index.canonicalToAliases) {
      index.canonicalToAliases.set(canonical, uniqueSorted(aliases));
    }

    index.buildFolded(source);
    return index;
  }

  resolve(model: string): string {
    const trimmed = model.trim();
    if (!trimmed) return trimmed;
    const direct = this.aliasToCanonical.get(trimmed);
    if (direct !== undefined) return direct;
    const folded = this.foldedAliases.get(trimmed.toLowerCase());
    if (folded !== undefined) return folded;
    return trimmed;
  }

  keys(model: string): string[] {
    const canonical = this.resolve(model);
    return uniqueSorted([canonical, ...(this.canonicalToAliases.get(canonical) ?? [])]);
  }

  private assign(alias: string, canonical: string, source: AliasSource): void {
    const trimmed = alias.trim();
    if (!trimmed) return;
    if (source.info(trimmed)) return;
    if (this.aliasToCanonical.has(trimmed)) return;
    this.aliasToCanonical.set(trimmed, canonical);
  }

  private buildFolded(source: AliasSource): void {
    const canonicals = [...source.canonicalIds()].sort((a, b) => compareText(a, b));
    for (const canonical of canonicals) {
      const key = canonical.toLowerCase();
      if (!this.foldedAliases.has(key)) this.foldedAliases.set(key, canonical);
    }
    const aliases = [...this.aliasToCanonical.keys()].sort((a, b) => compareText(a, b));
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (!this.foldedAliases.has(key)) {
        this.foldedAliases.set(key, this.aliasToCanonical.get(alias) as string);
      }
    }
  }
}
