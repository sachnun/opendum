import { readdirSync, readFileSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import type { ModelMeta } from "./capabilities.js";
import { compareModelEntries } from "./sort.js";

export interface ProviderModelConfig {
  upstream?: string;
  minTier?: string;
  allowedTiers?: string[];
  authless?: boolean;
  aliases?: string[];
  [key: string]: unknown;
}

export interface ModelInfo {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  family?: string;
  ignored?: boolean;
  meta?: ModelMeta;
  providerConfig?: Record<string, ProviderModelConfig>;
}

export interface ProviderAccessRule {
  minTier?: string;
  allowedTiers?: string[];
}

export class ModelRegistry {
  private models: Record<string, ModelInfo> = {};
  private ignored: Set<string> = new Set();
  private effective: Record<string, ModelInfo> = {};
  private aliasToCanonical: Record<string, string> = {};
  private canonicalToAliases: Record<string, string[]> = {};
  private providerModelMap: Map<string, Record<string, string>> = new Map();
  private providerModelSet: Map<string, Set<string>> = new Map();

  static fromDirectory(dir: string): ModelRegistry {
    const registry = new ModelRegistry();
    registry.loadDirectory(dir);
    return registry;
  }

  static fromEntries(entries: Record<string, ModelInfo>, ignoredList: string[] = []): ModelRegistry {
    const registry = new ModelRegistry();
    registry.models = { ...entries };
    registry.ignored = new Set(ignoredList);
    registry.rebuild();
    return registry;
  }

  public loadDirectory(dir: string) {
    const walk = (currentDir: string) => {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = resolve(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          try {
            const raw = readFileSync(fullPath, "utf-8");
            const info: ModelInfo = JSON.parse(raw);
            const fileId = basename(fullPath, ".json");
            const modelId = info.id?.trim() || fileId;
            info.id = modelId;
            if (info.ignored) {
              this.ignored.add(modelId);
            }
            this.models[modelId] = info;
          } catch (e) {
            console.error(`Failed to parse model file ${fullPath}:`, e);
          }
        }
      }
    };

    walk(dir);
    this.rebuild();
  }

  private rebuild() {
    this.effective = {};
    for (const [id, info] of Object.entries(this.models)) {
      if (!this.ignored.has(id)) {
        this.effective[id] = info;
      }
    }

    this.aliasToCanonical = {};
    for (const [canonical, info] of Object.entries(this.effective)) {
      if (info.id && info.id !== canonical) {
        this.aliasToCanonical[info.id] = canonical;
      }
      if (info.aliases) {
        for (const alias of info.aliases) {
          this.aliasToCanonical[alias] = canonical;
        }
      }
      if (info.providerConfig) {
        for (const config of Object.values(info.providerConfig)) {
          if (typeof config.upstream === "string" && config.upstream) {
            if (!this.aliasToCanonical[config.upstream]) {
              this.aliasToCanonical[config.upstream] = canonical;
            }
          }
        }
      }
    }

    this.canonicalToAliases = {};
    for (const [alias, canonical] of Object.entries(this.aliasToCanonical)) {
      this.canonicalToAliases[canonical] ??= [];
      this.canonicalToAliases[canonical].push(alias);
    }
    for (const canonical of Object.keys(this.canonicalToAliases)) {
      this.canonicalToAliases[canonical] = Array.from(new Set(this.canonicalToAliases[canonical]!)).sort();
    }

    this.providerModelMap.clear();
    this.providerModelSet.clear();
  }

  public resolveAlias(model: string): string {
    return this.aliasToCanonical[model] ?? model;
  }

  public getModel(model: string): ModelInfo | undefined {
    return this.effective[this.resolveAlias(model)];
  }

  public getEffectiveModels(): Record<string, ModelInfo> {
    return this.effective;
  }

  public getAllCanonicalModels(): string[] {
    return Object.keys(this.effective).filter((m) => (this.effective[m]?.providers?.length ?? 0) > 0);
  }

  public getProvidersForModel(model: string): string[] {
    const canonical = this.resolveAlias(model);
    return this.effective[canonical]?.providers ?? [];
  }

  public isModelSupportedByProvider(model: string, provider: string): boolean {
    return this.getProvidersForModel(model).includes(provider);
  }

  public getProviderModelMap(provider: string): Record<string, string> {
    const cached = this.providerModelMap.get(provider);
    if (cached) return cached;

    const map: Record<string, string> = {};
    for (const [canonical, info] of Object.entries(this.effective)) {
      if (!info.providers.includes(provider)) continue;
      map[canonical] = info.providerConfig?.[provider]?.upstream ?? canonical;
    }
    this.providerModelMap.set(provider, map);
    return map;
  }

  public upstreamModelName(model: string, provider: string): string {
    const canonical = this.resolveAlias(model);
    const info = this.effective[canonical];
    if (info?.providerConfig?.[provider]?.upstream) {
      return info.providerConfig[provider].upstream;
    }
    return canonical;
  }

  public isAuthlessProviderModel(model: string, provider: string): boolean {
    const canonical = this.resolveAlias(model);
    return this.effective[canonical]?.providerConfig?.[provider]?.authless === true;
  }

  public providerConfigBool(model: string, provider: string, key: string): boolean {
    const canonical = this.resolveAlias(model);
    return this.effective[canonical]?.providerConfig?.[provider]?.[key] === true;
  }

  public formatModelsForOpenAI(): Array<{ id: string; object: string; created: number; owned_by: string }> {
    const now = Math.floor(Date.now() / 1000);
    return this.getAllCanonicalModels().map((id) => ({
      id,
      object: "model",
      created: now,
      owned_by: this.effective[id]?.family ?? "system",
    }));
  }
}
