import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const MODEL_FILE_EXTENSION = ".json";

const MODEL_PROPERTY_ORDER = [
  "providers",
  "aliases",
  "description",
  "family",
  "ignored",
  "meta",
  "providerConfig",
];

const META_PROPERTY_ORDER = [
  "reasoning",
  "toolCall",
  "vision",
  "modalities",
];

const PROVIDER_CONFIG_PROPERTY_ORDER = ["upstream", "authless", "minTier", "aliases"];
const FIRST_PROVIDERS = new Set(["opencode"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function orderObject(value, preferredKeys = []) {
  const result = {};
  const preferred = new Set(preferredKeys);

  for (const key of preferredKeys) {
    if (value[key] !== undefined) {
      result[key] = orderValue(value[key], key);
    }
  }

  for (const key of Object.keys(value).filter((key) => !preferred.has(key)).sort()) {
    if (value[key] !== undefined) {
      result[key] = orderValue(value[key], key);
    }
  }

  return result;
}

function orderProviderMap(value, preferredKeys = []) {
  const result = {};
  for (const provider of Object.keys(value).sort()) {
    result[provider] = isPlainObject(value[provider])
      ? orderObject(value[provider], preferredKeys)
      : orderValue(value[provider], provider);
  }
  return result;
}

function orderProviders(value) {
  if (!Array.isArray(value)) return value;
  return [...value].sort((a, b) => {
    const aFirst = FIRST_PROVIDERS.has(a) ? 0 : 1;
    const bFirst = FIRST_PROVIDERS.has(b) ? 0 : 1;
    return aFirst - bFirst;
  });
}

function orderValue(value, key) {
  if (key === "providers") return orderProviders(value);
  if (Array.isArray(value)) return value.map((item) => orderValue(item));
  if (!isPlainObject(value)) return value;

  if (key === "meta") return orderObject(value, META_PROPERTY_ORDER);
  if (key === "modalities") return orderObject(value, ["input", "output"]);
  if (key === "providerConfig") return orderProviderMap(value, PROVIDER_CONFIG_PROPERTY_ORDER);
  return orderObject(value);
}

function normalizeModelData(data) {
  return orderObject(data, MODEL_PROPERTY_ORDER);
}

function readModelJson(content) {
  return JSON.parse(content);
}

export function writeModelJson(filePath, data) {
  const content = JSON.stringify(normalizeModelData(data), null, 2);
  writeFileSync(filePath, `${content}\n`);
}

function collectModelFiles(modelsDir) {
  const files = [];
  for (const entry of readdirSync(modelsDir)) {
    const fullPath = join(modelsDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const file of readdirSync(fullPath)) {
        if (file.endsWith(MODEL_FILE_EXTENSION)) {
          files.push(join(fullPath, file));
        }
      }
    }
  }
  return files;
}

/** Build index: modelId -> { path, data } */
export function buildModelIndex(modelsDir) {
  const index = {};
  for (const filePath of collectModelFiles(modelsDir)) {
    const modelId = basename(filePath, MODEL_FILE_EXTENSION);
    const content = readFileSync(filePath, "utf-8");
    index[modelId] = { path: filePath, data: readModelJson(content) };
  }
  return index;
}

const FAMILY_RULES = [
  { test: /^claude-/, folder: "claude" },
  { test: /^gpt-|^grok-|^o\d/, folder: "openai" },
  { test: /^gemini-/, folder: "gemini" },
  { test: /^gemma/, folder: "google" },
  { test: /^llama|^codellama/, folder: "meta" },
  { test: /^phi-/, folder: "microsoft" },
  { test: /^qwen|^qwq-/, folder: "qwen" },
  { test: /^deepseek-/, folder: "deepseek" },
  { test: /^kilo-auto-/, folder: "kilo-code" },
  { test: /^kimi-/, folder: "kimi" },
  { test: /^minimax-/, folder: "minimax" },
  { test: /^glm-/, folder: "zai" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, folder: "mistral" },
  { test: /^nemotron-|^nim-/, folder: "nvidia" },
  { test: /^openrouter-/, folder: "openrouter" },
];

function inferModelFolder(modelKey) {
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(modelKey)) return rule.folder;
  }
  return null;
}

/**
 * Sync a provider's model map into the JSON registry.
 *
 * @param {string} modelsDir Path to models/ directory
 * @param {string} providerName e.g. "nvidia_nim"
 * @param {Map<string,string>} modelMap modelKey -> upstreamName
 * @returns {{ added: string[], removed: string[], updated: string[] }}
 */
export function syncProviderModels(modelsDir, providerName, modelMap) {
  const index = buildModelIndex(modelsDir);
  const added = [];
  const removed = [];
  const updated = [];

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(providerName)) continue;
    if (modelMap.has(modelId)) continue;

    entry.data.providers = providers.filter((provider) => provider !== providerName);

    if (entry.data.providerConfig?.[providerName]) {
      delete entry.data.providerConfig[providerName];
      if (Object.keys(entry.data.providerConfig).length === 0) {
        delete entry.data.providerConfig;
      }
    }

    writeModelJson(entry.path, entry.data);
    removed.push(modelId);
  }

  for (const [modelKey, upstreamName] of modelMap.entries()) {
    const existing = index[modelKey];

    if (existing) {
      const providers = existing.data.providers || [];
      let changed = false;

      if (!providers.includes(providerName)) {
        providers.push(providerName);
        existing.data.providers = orderProviders(providers);
        changed = true;
      }

      const providerConfig = existing.data.providerConfig?.[providerName] || {};

      if (upstreamName !== modelKey) {
        if (!existing.data.providerConfig) existing.data.providerConfig = {};
        if (!existing.data.providerConfig[providerName]) existing.data.providerConfig[providerName] = {};
        if (existing.data.providerConfig[providerName].upstream !== upstreamName) {
          existing.data.providerConfig[providerName].upstream = upstreamName;
          changed = true;
        }
      } else if (providerConfig.upstream !== undefined) {
        delete providerConfig.upstream;
        changed = true;
        if (Object.keys(providerConfig).length === 0) {
          delete existing.data.providerConfig[providerName];
        }
        if (existing.data.providerConfig && Object.keys(existing.data.providerConfig).length === 0) {
          delete existing.data.providerConfig;
        }
      }

      if (changed) {
        writeModelJson(existing.path, existing.data);
        updated.push(modelKey);
      }
    } else {
      const folder = inferModelFolder(modelKey) || "other";
      const folderPath = join(modelsDir, folder);
      if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });

      const data = {
        providers: [providerName],
      };

      if (upstreamName !== modelKey) {
        data.providerConfig = {
          [providerName]: { upstream: upstreamName },
        };
      }

      const filePath = join(folderPath, `${modelKey}${MODEL_FILE_EXTENSION}`);
      writeModelJson(filePath, data);
      added.push(modelKey);
    }
  }

  return { added, removed, updated };
}

export function getProviderUpstream(data, providerName, modelId) {
  const providerConfig = data.providerConfig?.[providerName];
  if (
    providerConfig &&
    typeof providerConfig === "object" &&
    !Array.isArray(providerConfig) &&
    typeof providerConfig.upstream === "string" &&
    providerConfig.upstream.trim().length > 0
  ) {
    return providerConfig.upstream.trim();
  }

  return modelId;
}
