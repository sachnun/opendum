/**
 * Shared TOML utilities for model refresh scripts.
 *
 * Provides read/write helpers so that nvidia.mjs, ollama.mjs, openrouter.mjs
 * can operate directly on TOML files in models/ instead of TS constants.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal TOML parser (only needs to handle our simple model schema)
// ---------------------------------------------------------------------------

/**
 * Very small TOML parser that handles the subset used by model TOML files.
 * Supports: strings, numbers (with _), booleans, arrays of strings, tables.
 */
export function parseToml(content) {
  const result = {};
  let currentTable = result;
  let currentPath = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Table header
    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const path = tableMatch[1].split(".").map(s => s.trim());
      currentPath = path;
      let obj = result;
      for (const key of path) {
        if (!obj[key] || typeof obj[key] !== "object") obj[key] = {};
        obj = obj[key];
      }
      currentTable = obj;
      continue;
    }

    // Key-value
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const rawValue = kvMatch[2].trim();
      currentTable[key] = parseValue(rawValue);
    }
  }

  return result;
}

function parseValue(raw) {
  // String
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Array
  if (raw.startsWith("[")) {
    const items = [];
    const arrayContent = raw.slice(1, raw.lastIndexOf("]"));
    const itemRegex = /"([^"]*?)"/g;
    let m;
    while ((m = itemRegex.exec(arrayContent)) !== null) {
      items.push(m[1]);
    }
    return items;
  }
  // Number (may have underscores)
  const numStr = raw.replace(/_/g, "");
  const num = Number(numStr);
  if (!Number.isNaN(num)) return num;
  return raw;
}

// ---------------------------------------------------------------------------
// TOML serializer (canonical format for model files)
// ---------------------------------------------------------------------------

export function serializeToml(data) {
  const lines = [];

  // Top-level scalar fields
  if (data.release_date) lines.push(`release_date = "${data.release_date}"`);
  if (data.knowledge) lines.push(`knowledge = "${data.knowledge}"`);
  if (data.reasoning !== undefined) lines.push(`reasoning = ${data.reasoning}`);
  if (data.tool_call !== undefined) lines.push(`tool_call = ${data.tool_call}`);
  if (data.attachment !== undefined) lines.push(`attachment = ${data.attachment}`);
  if (lines.length > 0) lines.push("");

  // [cost]
  if (data.cost) {
    lines.push("[cost]");
    if (data.cost.input !== undefined) lines.push(`input = ${data.cost.input}`);
    if (data.cost.output !== undefined) lines.push(`output = ${data.cost.output}`);
    lines.push("");
  }

  // [limit]
  if (data.limit) {
    lines.push("[limit]");
    if (data.limit.context !== undefined) lines.push(`context = ${formatNumber(data.limit.context)}`);
    if (data.limit.output !== undefined) lines.push(`output = ${formatNumber(data.limit.output)}`);
    lines.push("");
  }

  // [modalities]
  if (data.modalities) {
    lines.push("[modalities]");
    if (data.modalities.input) lines.push(`input = ${JSON.stringify(data.modalities.input)}`);
    if (data.modalities.output) lines.push(`output = ${JSON.stringify(data.modalities.output)}`);
    lines.push("");
  }

  // [opendum]
  const op = data.opendum || {};
  lines.push("[opendum]");
  if (op.family) lines.push(`family = "${op.family}"`);
  const providers = op.providers || [];
  lines.push(`providers = [${providers.map(p => `"${p}"`).join(", ")}]`);
  if (op.aliases && op.aliases.length > 0) {
    lines.push(`aliases = [${op.aliases.map(a => `"${a}"`).join(", ")}]`);
  }
  if (op.description) lines.push(`description = "${op.description}"`);
  if (op.ignored) lines.push(`ignored = true`);

  // [opendum.upstream]
  const upstream = op.upstream || {};
  const upstreamEntries = Object.entries(upstream).filter(([, v]) => v != null);
  if (upstreamEntries.length > 0) {
    lines.push("");
    lines.push("[opendum.upstream]");
    for (const [provider, upstreamName] of upstreamEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${provider} = "${upstreamName}"`);
    }
  }

  lines.push(""); // trailing newline
  return lines.join("\n");
}

function formatNumber(n) {
  if (typeof n !== "number") return String(n);
  if (n >= 1000) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
  }
  return n.toString();
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

export function collectTomlFiles(modelsDir) {
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

/** Build index: modelId → { path, data } */
export function buildTomlIndex(modelsDir) {
  const index = {};
  for (const filePath of collectTomlFiles(modelsDir)) {
    const modelId = basename(filePath, ".toml");
    const content = readFileSync(filePath, "utf-8");
    index[modelId] = { path: filePath, data: parseToml(content) };
  }
  return index;
}

// ---------------------------------------------------------------------------
// Family detection (same rules as the old models.mjs)
// ---------------------------------------------------------------------------

const FAMILY_RULES = [
  { test: /^claude-/, folder: "claude" },
  { test: /^gpt-|^grok-|^o\d/, folder: "openai" },
  { test: /^gemini-/, folder: "gemini" },
  { test: /^gemma/, folder: "google" },
  { test: /^llama|^codellama/, folder: "meta" },
  { test: /^phi-/, folder: "microsoft" },
  { test: /^qwen|^qwq-/, folder: "qwen" },
  { test: /^deepseek-/, folder: "deepseek" },
  { test: /^kimi-/, folder: "kimi" },
  { test: /^minimax-/, folder: "minimax" },
  { test: /^glm-/, folder: "zai" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral|^mixtral/, folder: "mistral" },
  { test: /^nemotron-|^nim-/, folder: "nvidia" },
  { test: /^openrouter-/, folder: "openrouter" },
];

export function inferFamily(modelKey) {
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(modelKey)) return rule.folder;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core: sync a provider's model list into TOML files
// ---------------------------------------------------------------------------

/**
 * Sync a provider's model map into the TOML registry.
 *
 * @param {string} modelsDir        Path to models/ directory
 * @param {string} providerName     e.g. "nvidia_nim"
 * @param {Map<string,string>} modelMap  modelKey → upstreamName
 * @returns {{ added: string[], removed: string[], updated: string[] }}
 */
export function syncProviderToToml(modelsDir, providerName, modelMap) {
  const index = buildTomlIndex(modelsDir);
  const added = [];
  const removed = [];
  const updated = [];

  // 1. Remove provider from models no longer in the API
  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.opendum?.providers || [];
    if (!providers.includes(providerName)) continue;
    if (modelMap.has(modelId)) continue;

    // This model is no longer offered by this provider
    const newProviders = providers.filter(p => p !== providerName);
    entry.data.opendum.providers = newProviders;

    // Remove upstream entry for this provider
    if (entry.data.opendum?.upstream?.[providerName]) {
      delete entry.data.opendum.upstream[providerName];
      if (Object.keys(entry.data.opendum.upstream).length === 0) {
        delete entry.data.opendum.upstream;
      }
    }

    writeFileSync(entry.path, serializeToml(entry.data));
    removed.push(modelId);
  }

  // 2. Add/update models from the API
  for (const [modelKey, upstreamName] of modelMap.entries()) {
    const existing = index[modelKey];

    if (existing) {
      // Update existing TOML
      if (!existing.data.opendum) existing.data.opendum = {};
      const providers = existing.data.opendum.providers || [];
      let changed = false;

      if (!providers.includes(providerName)) {
        providers.push(providerName);
        providers.sort();
        existing.data.opendum.providers = providers;
        changed = true;
      }

      // Set upstream if different from canonical
      if (upstreamName !== modelKey) {
        if (!existing.data.opendum.upstream) existing.data.opendum.upstream = {};
        if (existing.data.opendum.upstream[providerName] !== upstreamName) {
          existing.data.opendum.upstream[providerName] = upstreamName;
          changed = true;
        }
      }

      if (changed) {
        writeFileSync(existing.path, serializeToml(existing.data));
        updated.push(modelKey);
      }
    } else {
      // Create new TOML
      const folder = inferFamily(modelKey) || "other";
      const folderPath = join(modelsDir, folder);
      if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });

      const data = {
        opendum: {
          providers: [providerName],
        },
      };

      if (upstreamName !== modelKey) {
        data.opendum.upstream = { [providerName]: upstreamName };
      }

      const filePath = join(folderPath, `${modelKey}.toml`);
      writeFileSync(filePath, serializeToml(data));
      added.push(modelKey);
    }
  }

  return { added, removed, updated };
}
