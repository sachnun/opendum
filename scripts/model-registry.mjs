import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse, patch, stringify, TomlFormat } from "@decimalturn/toml-patch";

function createModelTomlFormat() {
  const format = TomlFormat.default();
  format.bracketSpacing = false;
  return format;
}

const MODEL_TOML_FORMAT = createModelTomlFormat();

function readModelToml(content) {
  return parse(content, { integersAsBigInt: false });
}

export function writeModelToml(filePath, data) {
  const content = existsSync(filePath)
    ? patch(readFileSync(filePath, "utf-8"), data, MODEL_TOML_FORMAT)
    : stringify(data, MODEL_TOML_FORMAT);
  const normalized = content.replace(/= \[[ \t]+\]/g, "= []");
  writeFileSync(filePath, normalized.endsWith("\n") ? normalized : `${normalized}\n`);
}

function collectTomlFiles(modelsDir) {
  const files = [];
  for (const entry of readdirSync(modelsDir)) {
    const fullPath = join(modelsDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const file of readdirSync(fullPath)) {
        if (file.endsWith(".toml")) {
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
  for (const filePath of collectTomlFiles(modelsDir)) {
    const modelId = basename(filePath, ".toml");
    const content = readFileSync(filePath, "utf-8");
    index[modelId] = { path: filePath, data: readModelToml(content) };
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
 * Sync a provider's model map into the TOML registry.
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
    const providers = entry.data.opendum?.providers || [];
    if (!providers.includes(providerName)) continue;
    if (modelMap.has(modelId)) continue;

    entry.data.opendum.providers = providers.filter(p => p !== providerName);

    if (entry.data.opendum?.upstream?.[providerName]) {
      delete entry.data.opendum.upstream[providerName];
      if (Object.keys(entry.data.opendum.upstream).length === 0) {
        delete entry.data.opendum.upstream;
      }
    }
    if (entry.data[providerName] && typeof entry.data[providerName] === "object") {
      delete entry.data[providerName];
    }

    writeModelToml(entry.path, entry.data);
    removed.push(modelId);
  }

  for (const [modelKey, upstreamName] of modelMap.entries()) {
    const existing = index[modelKey];

    if (existing) {
      if (!existing.data.opendum) existing.data.opendum = {};
      const providers = existing.data.opendum.providers || [];
      let changed = false;

      if (!providers.includes(providerName)) {
        providers.push(providerName);
        providers.sort();
        existing.data.opendum.providers = providers;
        changed = true;
      }

      if (!existing.data[providerName] || typeof existing.data[providerName] !== "object") {
        existing.data[providerName] = {};
      }

      if (upstreamName !== modelKey) {
        if (existing.data[providerName].upstream !== upstreamName) {
          existing.data[providerName].upstream = upstreamName;
          changed = true;
        }
      } else if (existing.data[providerName].upstream !== undefined) {
        delete existing.data[providerName].upstream;
        changed = true;
      }

      if (Object.keys(existing.data[providerName]).length === 0) {
        delete existing.data[providerName];
      }

      if (changed) {
        writeModelToml(existing.path, existing.data);
        updated.push(modelKey);
      }
    } else {
      const folder = inferModelFolder(modelKey) || "other";
      const folderPath = join(modelsDir, folder);
      if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });

      const data = {
        opendum: {
          providers: [providerName],
        },
      };

      if (upstreamName !== modelKey) {
        data[providerName] = { upstream: upstreamName };
      }

      const filePath = join(folderPath, `${modelKey}.toml`);
      writeModelToml(filePath, data);
      added.push(modelKey);
    }
  }

  return { added, removed, updated };
}
