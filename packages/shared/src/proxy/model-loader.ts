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

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

export interface ModelMeta {
  contextLength?: number;
  outputLimit?: number;
  knowledgeCutoff?: string;
  releaseDate?: string;
  reasoning?: boolean;
  toolCall?: boolean;
  vision?: boolean;
  modalities?: {
    input: string[];
    output: string[];
  };
}

export interface ModelInfo {
  providers: string[];
  aliases?: string[];
  description?: string;
  /** Model family name (e.g. "Claude", "OpenAI"). Read from [opendum].family in TOML. */
  family?: string;
  meta?: ModelMeta;
  /** Per-provider upstream model name. When absent, the canonical id is used. */
  upstream?: Record<string, string>;
  access?: Record<
    string,
    {
      minTier?: string;
    }
  >;
  providerConfig?: Record<
    string,
    {
      upstream?: string;
      minTier?: string;
      aliases?: string[];
    }
  >;
}

interface TomlModel {
  // models.dev compatible fields
  release_date?: string;
  knowledge?: string;
  reasoning?: boolean;
  tool_call?: boolean;
  attachment?: boolean;        // maps to ModelMeta.vision
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
    access?: Record<
      string,
      {
        min_tier?: string;
      }
    >;
  };
  [key: string]: unknown;
}

const RESERVED_TOP_LEVEL_TABLES = new Set(["limit", "modalities", "opendum"]);

function extractProviderConfigs(raw: TomlModel): ModelInfo["providerConfig"] {
  const entries = Object.entries(raw)
    .filter(([key]) => !RESERVED_TOP_LEVEL_TABLES.has(key))
    .map(([provider, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }

      const record = value as Record<string, unknown>;
      const upstream = typeof record.upstream === "string" && record.upstream.trim().length > 0
        ? record.upstream.trim()
        : undefined;
      const minTier = typeof record.min_tier === "string" && record.min_tier.trim().length > 0
        ? record.min_tier.trim()
        : undefined;
      const aliases = Array.isArray(record.aliases)
        ? record.aliases.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
        : undefined;

      if (!upstream && !minTier && (!aliases || aliases.length === 0)) {
        return null;
      }

      return [
        provider,
        {
          ...(upstream ? { upstream } : {}),
          ...(minTier ? { minTier } : {}),
          ...(aliases && aliases.length > 0 ? { aliases } : {}),
        },
      ] as const;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function resolveModelsDir(): string {
  // Try to find the models directory relative to this file's location.
  // When built: dist/proxy/model-loader.js → ../../models
  // When running from source: src/proxy/model-loader.ts → ../../models
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const relativeModelsDir = join(__dirname, "..", "..", "models");

  if (existsSync(relativeModelsDir)) {
    return relativeModelsDir;
  }

  // Fallback: look in process.cwd()/models (backward compatibility)
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

function tomlToModelInfo(raw: TomlModel): ModelInfo {
  const opendum = raw.opendum ?? {};
  const providers = opendum.providers ?? [];
  const aliases = opendum.aliases;
  const description = opendum.description;
  const family = opendum.family;
  const providerConfig = extractProviderConfigs(raw);
  const upstream = {
    ...(opendum.upstream ?? {}),
    ...Object.fromEntries(
      Object.entries(providerConfig ?? {})
        .filter(([, config]) => typeof config.upstream === "string")
        .map(([provider, config]) => [provider, config.upstream as string])
    ),
  };
  const access = {
    ...Object.fromEntries(
      Object.entries(opendum.access ?? {}).map(([provider, rule]) => [
        provider,
        {
          ...(rule?.min_tier ? { minTier: rule.min_tier } : {}),
        },
      ])
    ),
    ...Object.fromEntries(
      Object.entries(providerConfig ?? {})
        .filter(([, config]) => typeof config.minTier === "string")
        .map(([provider, config]) => [
          provider,
          {
            minTier: config.minTier,
          },
        ])
    ),
  };

  const hasMeta =
    raw.release_date !== undefined ||
    raw.knowledge !== undefined ||
    raw.reasoning !== undefined ||
    raw.tool_call !== undefined ||
    raw.attachment !== undefined ||
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
    family,
    meta,
    upstream: Object.keys(upstream).length > 0 ? upstream : undefined,
    access: Object.keys(access).length > 0 ? access : undefined,
    providerConfig,
  };
}

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

const loaded = loadModels();

/** All models loaded from TOML files. */
export const MODEL_REGISTRY: Record<string, ModelInfo> = loaded.registry;

/** Model IDs marked as ignored (hidden from UI and API). */
export const IGNORED_MODELS: Set<string> = loaded.ignoredModels;
