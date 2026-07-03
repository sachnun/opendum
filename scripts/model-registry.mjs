import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { aliasesFromUpstream } from "./lib/clean-key.mjs";

const MODEL_FILE_EXTENSION = ".json";

const MODEL_PROPERTY_ORDER = [
  "id",
  "providers",
  "aliases",
  "description",
  "ignored",
  "meta",
  "providerConfig",
];

const META_PROPERTY_ORDER = [
  "reasoning",
  "toolCall",
  "vision",
  "type",
  "code",
  "tier",
  "variant",
  "status",
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
  if (key === "providerConfig") return orderProviderMap(value, PROVIDER_CONFIG_PROPERTY_ORDER);
  return orderObject(value);
}

function normalizeModelData(data) {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    delete data.family;
  }
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
  { test: /^claude-/, folder: "anthropic", family: "Anthropic" },
  { test: /^gpt($|-)|^chatgpt-|^o($|-)|^o\d/, folder: "openai", family: "OpenAI" },
  { test: /^gemini-?|^gemma|^diffusiongemma/, folder: "google", family: "Google" },
  { test: /^grok-?/, folder: "xai", family: "xAI" },
  { test: /^llama|^codellama/, folder: "meta", family: "Meta" },
  { test: /^phi-?/, folder: "microsoft", family: "Microsoft" },
  { test: /^qwen|^qwq-/, folder: "qwen", family: "Qwen" },
  { test: /^deepseek-?/, folder: "deepseek", family: "DeepSeek" },
  { test: /^kilo-auto-?/, folder: "kilo-code", family: "Kilo Code" },
  { test: /^kimi-?/, folder: "moonshot", family: "Moonshot" },
  { test: /^minimax-?/, folder: "minimax", family: "MiniMax" },
  { test: /^glm-?/, folder: "z-ai", family: "Z.AI" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, folder: "mistral", family: "Mistral" },
  { test: /^nemotron-|^nim-?/, folder: "nvidia", family: "NVIDIA" },
  { test: /^openrouter-?/, folder: "openrouter", family: "OpenRouter" },
  { test: /^mimo-?/, folder: "xiaomi", family: "Xiaomi" },
  { test: /^hunyuan|^hy3/, folder: "hunyuan", family: "Hunyuan" },
  { test: /^ling-|^ring-|^ling/, folder: "inclusion-ai", family: "InclusionAI" },
  { test: /^mai-code/, folder: "microsoft", family: "Microsoft" },
  { test: /^nex-n|^nex-n2/, folder: "nex-agi", family: "Nex AGI" },
  { test: /^north-/, folder: "cohere", family: "Cohere" },
];

const FAMILY_BY_FOLDER = Object.fromEntries(
  FAMILY_RULES.map((rule) => [rule.folder, rule.family])
);

export function inferFamilyFromFolder(folderName) {
  if (!folderName) return null;
  return FAMILY_BY_FOLDER[folderName] ?? null;
}

function inferModelFolder(modelKey) {
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(modelKey.toLowerCase())) return rule.folder;
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
  const modelUpstreams = new Set(modelMap.values());
  const added = [];
  const removed = [];
  const updated = [];

  function extraProviderConfig(modelKey) {
    return options.providerConfigByModel?.get(modelKey) ?? {};
  }

  function findParentForCollision(modelKey, upstreamName) {
    const entries = Object.values(index);
    if (index[modelKey]) return null;

    const suffixMatch = modelKey.match(/^(.+?)(?:-(\d+)|-v(\d+(?:\.\d+)*))$/);
    if (suffixMatch) {
      const [, base, numericSuffix, versionSuffix] = suffixMatch;
      const isMeaningfulSuffix =
        (numericSuffix && Number.parseInt(numericSuffix, 10) >= 2) || versionSuffix;
      if (isMeaningfulSuffix) {
        const parent =
          index[base] ||
          entries.find((entry) => entry.id === base) ||
          entries.find((entry) => entry.fileId !== modelKey && (entry.data.aliases || []).includes(base));
        if (parent) return { baseKey: base, entry: parent };
      }
    }
    const covered =
      entries.find(
        (entry) =>
          entry.fileId !== modelKey &&
          (entry.data.aliases || []).includes(upstreamName),
      ) ||
      entries.find(
        (entry) =>
          entry.fileId !== modelKey &&
          getProviderUpstream(entry.data, providerName, entry.fileId) === upstreamName,
      );
    if (covered) return { baseKey: covered.fileId, entry: covered };
    return null;
  }
  for (const [modelKey, upstreamName] of [...modelMap.entries()]) {
    const parent = findParentForCollision(modelKey, upstreamName);
    if (!parent) continue;

    const existingAliases = new Set(parent.entry.data.aliases || []);
    let changed = false;
    for (const alias of aliasesFromUpstream([upstreamName])) {
      if (!existingAliases.has(alias)) {
        existingAliases.add(alias);
        changed = true;
      }
    }
    if (changed) {
      parent.entry.data.aliases = [...existingAliases].sort();
      writeModelJson(parent.entry.path, parent.entry.data);
      updated.push(parent.baseKey);
    }
    modelMap.delete(modelKey);
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
    if (modelMap.has(entry.fileId) || modelMap.has(entry.id)) return true;
    const upstream = getProviderUpstream(entry.data, providerName, entry.id);
    if (upstream && modelUpstreams.has(upstream)) return true;
    const aliases = entry.data.aliases || [];
    return aliases.some((alias) => modelMap.has(alias) || modelUpstreams.has(alias));
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
      const folder = inferModelFolder(modelKey);
      const filePath = folder
        ? join(modelsDir, folder, `${modelKey}${MODEL_FILE_EXTENSION}`)
        : join(modelsDir, `${modelKey}${MODEL_FILE_EXTENSION}`);
      if (folder) {
        const folderPath = join(modelsDir, folder);
        if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });
      }

      // If a file with the same canonical name already exists (e.g. as a
      // legacy/ignored catch-all), merge providers/providerConfig into the
      // existing file instead of overwriting it. The existing meta/aliases/
      // ignored flags are preserved.
      if (existsSync(filePath)) {
        const existing = readModelJson(readFileSync(filePath, "utf-8"));
        const existingProviders = existing.providers || [];
        let touched = false;

        if (!existingProviders.includes(providerName)) {
          existing.providers = orderProviders([...existingProviders, providerName]);
          touched = true;
        }

        const extra = extraProviderConfig(modelKey);
        const wantsProviderConfig = Object.keys(extra).length > 0
          || upstreamName !== (existing.id || modelKey)
          || (existing.providerConfig && existing.providerConfig[providerName]);

        if (wantsProviderConfig) {
          if (!existing.providerConfig) existing.providerConfig = {};
          if (!existing.providerConfig[providerName]) existing.providerConfig[providerName] = {};
          const nextProviderConfig = existing.providerConfig[providerName];
          for (const [key, value] of Object.entries(extra)) {
            if (JSON.stringify(nextProviderConfig[key]) !== JSON.stringify(value)) {
              nextProviderConfig[key] = value;
              touched = true;
            }
          }
          if (upstreamName !== modelKey && nextProviderConfig.upstream !== upstreamName) {
            nextProviderConfig.upstream = upstreamName;
            touched = true;
          }
          if (Object.keys(nextProviderConfig).length === 0) {
            delete existing.providerConfig[providerName];
          }
          if (Object.keys(existing.providerConfig).length === 0) {
            delete existing.providerConfig;
          }
        }

        if (touched) {
          writeModelJson(filePath, existing);
          updated.push(modelKey);
        }
        continue;
      }

      const data = {
        providers: [providerName],
      };

      const providerConfig = { ...extraProviderConfig(modelKey) };
      if (upstreamName !== modelKey) {
        providerConfig.upstream = upstreamName;
      }
      if (Object.keys(providerConfig).length > 0) {
        data.providerConfig = {
          [providerName]: providerConfig,
        };
      }

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
