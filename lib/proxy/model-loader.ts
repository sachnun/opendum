/**
 * Model loader — reads TOML files from the models/ directory at runtime
 * and produces the ModelInfo / ModelMeta types consumed by the proxy layer.
 *
 * SERVER-ONLY: this module uses node:fs and must never be imported by
 * client components.  Only models.ts (server-side) imports from here.
 *
 * All TOML files are parsed synchronously on first import so the registry
 * is immediately available — no async needed by consumers.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { parse } from "smol-toml";

// ---------------------------------------------------------------------------
// Types (re-exported by models.ts for the rest of the codebase)
// ---------------------------------------------------------------------------

export interface ModelMeta {
  contextLength?: number;
  outputLimit?: number;
  knowledgeCutoff?: string;
  releaseDate?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  pricing?: {
    input: number;
    output: number;
  };
  modalities?: {
    input: string[];
    output: string[];
  };
}

export interface ModelInfo {
  providers: string[];
  aliases?: string[];
  description?: string;
  meta?: ModelMeta;
  /** Per-provider upstream model name. When absent, the canonical id is used. */
  upstream?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// TOML schema (shape of each .toml file)
// ---------------------------------------------------------------------------

interface TomlModel {
  // models.dev compatible fields
  release_date?: string;
  knowledge?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;        // maps to ModelMeta.vision
  cost?: {
    input?: number;
    output?: number;
  };
  limit?: {
    context?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
  // opendum extensions
  opendum?: {
    family?: string;
    providers?: string[];
    aliases?: string[];
    ignored?: boolean;
    description?: string;
    upstream?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Directory scanning
// ---------------------------------------------------------------------------

function resolveModelsDir(): string {
  return join(process.cwd(), "models");
}

function collectTomlFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...collectTomlFiles(fullPath));
    } else if (entry.endsWith(".toml")) {
      files.push(fullPath);
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// TOML → ModelInfo conversion
// ---------------------------------------------------------------------------

function tomlToModelInfo(raw: TomlModel): ModelInfo {
  const opendum = raw.opendum ?? {};
  const providers = opendum.providers ?? [];
  const aliases = opendum.aliases;
  const description = opendum.description;
  const upstream = opendum.upstream;

  const hasMeta =
    raw.release_date !== undefined ||
    raw.knowledge !== undefined ||
    raw.reasoning !== undefined ||
    raw.tool_call !== undefined ||
    raw.attachment !== undefined ||
    raw.cost !== undefined ||
    raw.limit !== undefined ||
    raw.modalities !== undefined;

  let meta: ModelMeta | undefined;
  if (hasMeta) {
    meta = {};
    if (raw.limit?.context !== undefined) meta.contextLength = raw.limit.context;
    if (raw.limit?.output !== undefined) meta.outputLimit = raw.limit.output;
    if (raw.knowledge !== undefined) meta.knowledgeCutoff = raw.knowledge;
    if (raw.release_date !== undefined) meta.releaseDate = raw.release_date;
    if (raw.reasoning !== undefined) meta.reasoning = raw.reasoning;
    if (raw.tool_call !== undefined) meta.toolCall = raw.tool_call;
    if (raw.attachment !== undefined) meta.vision = raw.attachment;
    if (raw.cost?.input !== undefined && raw.cost?.output !== undefined) {
      meta.pricing = { input: raw.cost.input, output: raw.cost.output };
    }
    if (raw.modalities) {
      meta.modalities = {
        input: raw.modalities.input ?? [],
        output: raw.modalities.output ?? [],
      };
    }
  }

  return {
    providers,
    aliases: aliases && aliases.length > 0 ? aliases : undefined,
    description,
    meta,
    upstream: upstream && Object.keys(upstream).length > 0 ? upstream : undefined,
  };
}

// ---------------------------------------------------------------------------
// Load all models from TOML
// ---------------------------------------------------------------------------

interface LoadResult {
  registry: Record<string, ModelInfo>;
  ignoredModels: Set<string>;
}

function loadModels(): LoadResult {
  const modelsDir = resolveModelsDir();
  const files = collectTomlFiles(modelsDir);

  const registry: Record<string, ModelInfo> = {};
  const ignoredModels = new Set<string>();

  for (const file of files) {
    const modelId = basename(file, ".toml");
    const content = readFileSync(file, "utf-8");

    let raw: TomlModel;
    try {
      raw = parse(content) as unknown as TomlModel;
    } catch (err) {
      console.error(`Failed to parse ${file}:`, err);
      continue;
    }

    registry[modelId] = tomlToModelInfo(raw);

    if (raw.opendum?.ignored) {
      ignoredModels.add(modelId);
    }
  }

  return { registry, ignoredModels };
}

// ---------------------------------------------------------------------------
// Module-level initialization — runs once on first import
// ---------------------------------------------------------------------------

const loaded = loadModels();

/** All models loaded from TOML files. */
export const MODEL_REGISTRY: Record<string, ModelInfo> = loaded.registry;

/** Model IDs marked as ignored (hidden from UI and API). */
export const IGNORED_MODELS: Set<string> = loaded.ignoredModels;
