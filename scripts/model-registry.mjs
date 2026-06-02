import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const MODEL_FILE_EXTENSION = ".json";

const MODEL_PROPERTY_ORDER = [
  "id",
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

const PROVIDER_CONFIG_PROPERTY_ORDER = ["upstream", "authless", "minTier", "allowedTiers", "aliases"];
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

function getModelPublicId(data, fileId) {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  return id || fileId;
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
    const fileId = basename(filePath, MODEL_FILE_EXTENSION);
    const content = readFileSync(filePath, "utf-8");
    const data = readModelJson(content);
    index[fileId] = { id: getModelPublicId(data, fileId), fileId, path: filePath, data };
  }
  return index;
}

const FAMILY_RULES = [
  { test: /^claude-/, folder: "claude", family: "Claude" },
  { test: /^gpt($|-)|^chatgpt-|^o($|-)|^o\d/, folder: "openai", family: "OpenAI" },
  { test: /^gemini-?/, folder: "gemini", family: "Gemini" },
  { test: /^grok-?/, folder: "xai", family: "xAI" },
  { test: /^gemma/, folder: "google", family: "Gemini" },
  { test: /^llama|^codellama/, folder: "meta", family: "Meta" },
  { test: /^phi-?/, folder: "microsoft", family: "Microsoft" },
  { test: /^qwen|^qwq-/, folder: "qwen", family: "Qwen" },
  { test: /^deepseek-?/, folder: "deepseek", family: "DeepSeek" },
  { test: /^kilo-auto-?/, folder: "kilo-code", family: "Kilo Code" },
  { test: /^kimi-?/, folder: "kimi", family: "Kimi" },
  { test: /^minimax-?/, folder: "minimax", family: "MiniMax" },
  { test: /^glm-?/, folder: "zai", family: "Z.AI" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, folder: "mistral", family: "Mistral" },
  { test: /^nemotron-|^nim-?/, folder: "nvidia", family: "NVIDIA" },
  { test: /^openrouter-?/, folder: "openrouter", family: "Openrouter" },
  { test: /^mimo-?/, folder: "other", family: "Xiaomi" },
];

function inferModelFolder(modelKey) {
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(modelKey.toLowerCase())) return rule.folder;
  }
  return null;
}

function inferModelFamily(modelKey) {
  if (!modelKey || typeof modelKey !== "string") return null;
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(modelKey.toLowerCase())) return rule.family;
  }
  return null;
}

/**
 * Sync a provider's model map into the JSON registry.
 *
 * @param {string} modelsDir Path to models/ directory
 * @param {string} providerName e.g. "nvidia_nim"
 * @param {Map<string,string>} modelMap modelKey -> upstreamName
 * @param {{ providerConfigByModel?: Map<string, Record<string, unknown>>, managedProviderConfigKeys?: string[] }} [options]
 * @returns {{ added: string[], removed: string[], updated: string[] }}
 */
export function syncProviderModels(modelsDir, providerName, modelMap, options = {}) {
  const index = buildModelIndex(modelsDir);
  const added = [];
  const removed = [];
  const updated = [];

  function extraProviderConfig(modelKey) {
    return options.providerConfigByModel?.get(modelKey) ?? {};
  }

  function applyManagedProviderConfig(providerConfig, modelKey) {
    let changed = false;
    const extraConfig = extraProviderConfig(modelKey);
    const managedKeys = options.managedProviderConfigKeys ?? Object.keys(extraConfig);

    for (const key of managedKeys) {
      const nextValue = extraConfig[key];
      if (nextValue === undefined) {
        if (providerConfig[key] !== undefined) {
          delete providerConfig[key];
          changed = true;
        }
        continue;
      }
      if (JSON.stringify(providerConfig[key]) !== JSON.stringify(nextValue)) {
        providerConfig[key] = nextValue;
        changed = true;
      }
    }

    return changed;
  }

  function entryMatchesProviderMap(entry) {
    return modelMap.has(entry.fileId) || modelMap.has(entry.id);
  }

  function findExistingEntry(modelKey, upstreamName) {
    if (index[modelKey]) return index[modelKey];

    const entries = Object.values(index);
    return entries.find((entry) => entry.id === modelKey) ||
      entries.find((entry) => (entry.data.aliases || []).includes(modelKey)) ||
      entries.find((entry) => getProviderUpstream(entry.data, providerName, entry.fileId) === upstreamName) ||
      null;
  }

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(providerName)) continue;
    if (entryMatchesProviderMap(entry)) continue;

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
    const existing = findExistingEntry(modelKey, upstreamName);

    if (existing) {
      const providers = existing.data.providers || [];
      let changed = false;

      if (!providers.includes(providerName)) {
        providers.push(providerName);
        existing.data.providers = orderProviders(providers);
        changed = true;
      }

      const extraConfig = extraProviderConfig(modelKey);
      const managedKeys = options.managedProviderConfigKeys ?? Object.keys(extraConfig);
      const providerConfig = existing.data.providerConfig?.[providerName] || {};
      const hasManagedProviderConfig = managedKeys.some((key) => providerConfig[key] !== undefined);

      if (upstreamName !== existing.id || Object.keys(extraConfig).length > 0 || hasManagedProviderConfig || providerConfig.upstream !== undefined) {
        if (!existing.data.providerConfig) existing.data.providerConfig = {};
        if (!existing.data.providerConfig[providerName]) existing.data.providerConfig[providerName] = {};
        const nextProviderConfig = existing.data.providerConfig[providerName];
        if (applyManagedProviderConfig(nextProviderConfig, modelKey)) {
          changed = true;
        }
        if (upstreamName !== existing.id && nextProviderConfig.upstream !== upstreamName) {
          nextProviderConfig.upstream = upstreamName;
          changed = true;
        } else if (upstreamName === existing.id && nextProviderConfig.upstream !== undefined) {
          delete nextProviderConfig.upstream;
          changed = true;
        }
        if (Object.keys(nextProviderConfig).length === 0) {
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

      const family = inferModelFamily(modelKey) || inferModelFamily(upstreamName);
      if (family) data.family = family;

      const providerConfig = { ...extraProviderConfig(modelKey) };
      if (upstreamName !== modelKey) {
        providerConfig.upstream = upstreamName;
      }
      if (Object.keys(providerConfig).length > 0) {
        data.providerConfig = {
          [providerName]: providerConfig,
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
