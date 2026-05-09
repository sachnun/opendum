import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "smol-toml";

const modelsDir = join(import.meta.dirname, "..", "..", "..", "models");
const outputFile = join(import.meta.dirname, "..", "server", "lib", "proxy", "generated-model-registry.ts");
const RESERVED_TABLES = new Set(["limit", "modalities", "opendum"]);

function collectTomlFiles(dir) {
  const files = [];
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

function extractProviderConfigs(raw) {
  const entries = Object.entries(raw)
    .filter(([key]) => !RESERVED_TABLES.has(key))
    .map(([provider, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;

      const upstream = typeof value.upstream === "string" && value.upstream.trim().length > 0
        ? value.upstream.trim()
        : undefined;
      const minTier = typeof value.min_tier === "string" && value.min_tier.trim().length > 0
        ? value.min_tier.trim()
        : undefined;
      const aliases = Array.isArray(value.aliases)
        ? value.aliases.filter((alias) => typeof alias === "string" && alias.trim().length > 0)
        : undefined;
      const custom = Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "upstream" && key !== "min_tier" && key !== "aliases")
      );

      if (!upstream && !minTier && (!aliases || aliases.length === 0) && Object.keys(custom).length === 0) return null;

      return [
        provider,
        {
          ...(upstream ? { upstream } : {}),
          ...(minTier ? { minTier } : {}),
          ...(aliases && aliases.length > 0 ? { aliases } : {}),
          ...custom,
        },
      ];
    })
    .filter((entry) => entry !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function tomlToModelInfo(raw) {
  const opendum = raw.opendum ?? {};
  const providerConfig = extractProviderConfigs(raw);
  const upstream = {
    ...(opendum.upstream ?? {}),
    ...Object.fromEntries(
      Object.entries(providerConfig ?? {})
        .filter(([, config]) => typeof config.upstream === "string")
        .map(([provider, config]) => [provider, config.upstream])
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
        .map(([provider, config]) => [provider, { minTier: config.minTier }])
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

  let meta;
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
    providers: opendum.providers ?? [],
    ...(opendum.aliases && opendum.aliases.length > 0 ? { aliases: opendum.aliases } : {}),
    ...(opendum.description ? { description: opendum.description } : {}),
    ...(opendum.family ? { family: opendum.family } : {}),
    ...(meta ? { meta } : {}),
    ...(Object.keys(upstream).length > 0 ? { upstream } : {}),
    ...(Object.keys(access).length > 0 ? { access } : {}),
    ...(providerConfig ? { providerConfig } : {}),
  };
}

const registry = {};
const ignoredModels = [];

for (const file of collectTomlFiles(modelsDir)) {
  const modelId = basename(file, ".toml");
  const raw = parse(readFileSync(file, "utf-8"));
  registry[modelId] = tomlToModelInfo(raw);
  if (raw.opendum?.ignored) ignoredModels.push(modelId);
}

const content = `import type { ModelInfo } from "./loader";

export const GENERATED_MODEL_REGISTRY = ${JSON.stringify(registry, null, 2)} as const satisfies Record<string, ModelInfo>;

export const GENERATED_IGNORED_MODELS = new Set<string>(${JSON.stringify(ignoredModels, null, 2)});
`;

writeFileSync(outputFile, content);
