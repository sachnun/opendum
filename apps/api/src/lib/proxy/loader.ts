import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ModelMeta } from "../../lib/model-capabilities.js";

export type { ModelMeta };

export interface ModelInfo {
  id?: string;
  providers: string[];
  aliases?: string[];
  description?: string;
  /** Model family name (e.g. "Anthropic", "OpenAI"). */
  family?: string;
  ignored?: boolean;
  meta?: ModelMeta;
  providerConfig?: Record<
    string,
    {
      upstream?: string;
      minTier?: string;
      allowedTiers?: string[];
      aliases?: string[];
      [key: string]: unknown;
    }
  >;
}

function collectModelFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return collectModelFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  }).sort((a, b) => a.localeCompare(b));
}

function collectFamilyByFileId(modelsDir: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        result[basename(fullPath, ".json")] = basename(dir);
      }
    }
  }
  walk(modelsDir);
  return result;
}

function resolveModelsDir(): string {
  if (process.env.MODELS_DIR) return process.env.MODELS_DIR;
  const candidates = [
    resolve(process.cwd(), "models"),
    resolve(process.cwd(), "../../models"),
    resolve(process.cwd(), "../../../models"),
    resolve(import.meta.dirname ?? process.cwd(), "../../../../models"),
  ];
  for (const candidate of candidates) {
    try {
      if (readdirSync(candidate).length >= 0) return candidate;
    } catch {
      // continue
    }
  }
  throw new Error("MODELS_DIR is required when models cannot be auto-detected");
}

function mergeModelInfo(modelId: string, fileId: string, info: ModelInfo, registry: Record<string, ModelInfo>, folderFamily: string | null): void {
  const next: ModelInfo = { ...info, id: info.id || modelId };
  if (fileId !== modelId) {
    next.aliases = Array.from(new Set([...(next.aliases || []), fileId])).sort((a, b) => a.localeCompare(b));
  }
  const existing = registry[modelId];
  if (!existing) {
    registry[modelId] = { ...next, family: next.family || folderFamily || undefined };
    return;
  }
  registry[modelId] = {
    ...existing,
    ...next,
    id: modelId,
    providers: Array.from(new Set([...(existing.providers || []), ...(next.providers || [])])).sort((a, b) => a.localeCompare(b)),
    aliases: Array.from(new Set([...(existing.aliases || []), ...(next.aliases || [])])).sort((a, b) => a.localeCompare(b)),
    description: existing.description || next.description,
    family: existing.family || next.family || folderFamily || undefined,
    ignored: Boolean(existing.ignored && next.ignored),
    meta: existing.meta || next.meta,
    providerConfig: { ...(existing.providerConfig || {}), ...(next.providerConfig || {}) },
  };
}

function loadRegistry(): { MODEL_REGISTRY: Record<string, ModelInfo>; IGNORED_MODELS: Set<string> } {
  const modelsDir = resolveModelsDir();
  const modelFiles = collectModelFiles(modelsDir);
  const familyByFileId = collectFamilyByFileId(modelsDir);
  const MODEL_REGISTRY: Record<string, ModelInfo> = {};

  for (const filePath of modelFiles) {
    const fileId = basename(filePath, ".json");
    const info = JSON.parse(readFileSync(filePath, "utf8")) as ModelInfo;
    mergeModelInfo(info.id || fileId, fileId, info, MODEL_REGISTRY, familyByFileId[fileId] || null);
  }

  const IGNORED_MODELS = new Set(
    Object.entries(MODEL_REGISTRY)
      .filter(([, info]) => info.ignored)
      .map(([modelId]) => modelId),
  );

  return { MODEL_REGISTRY, IGNORED_MODELS };
}

const loaded = loadRegistry();

export const MODEL_REGISTRY = loaded.MODEL_REGISTRY;
export const IGNORED_MODELS = loaded.IGNORED_MODELS;
