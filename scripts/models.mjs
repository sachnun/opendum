#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = join(rootDir, "models");

const refreshScripts = [
  "openrouter.mjs",
  "nvidia.mjs",
  "ollama.mjs",
];

// ---------------------------------------------------------------------------
// Provider constants paths & regex
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    name: "nvidia-nim",
    file: "lib/proxy/providers/nvidia-nim/constants.ts",
    pattern: /export const NVIDIA_NIM_MODEL_MAP: Record<string, string> = \{([\s\S]*?)\n\};/,
  },
  {
    name: "ollama-cloud",
    file: "lib/proxy/providers/ollama-cloud/constants.ts",
    pattern: /export const OLLAMA_CLOUD_MODEL_MAP: Record<string, string> = \{([\s\S]*?)\n\};/,
  },
  {
    name: "openrouter",
    file: "lib/proxy/providers/openrouter/constants.ts",
    pattern: /export const OPENROUTER_MODEL_MAP: Record<string, string> = \{([\s\S]*?)\n\};/,
  },
];

// ---------------------------------------------------------------------------
// Mainstream family detection — only these get auto-created TOML files
// ---------------------------------------------------------------------------

const FAMILY_RULES = [
  { test: /^claude-/, folder: "claude" },
  { test: /^gpt-|^grok-/, folder: "openai" },
  { test: /^gemini-/, folder: "gemini" },
  { test: /^gemma/, folder: "google" },
  { test: /^llama|^codellama/, folder: "meta" },
  { test: /^phi-/, folder: "microsoft" },
  { test: /^qwen|^qwq-/, folder: "qwen" },
  { test: /^deepseek-/, folder: "deepseek" },
  { test: /^kimi-/, folder: "kimi" },
  { test: /^minimax-/, folder: "minimax" },
  { test: /^glm-/, folder: "zai" },
  { test: /^mistral-|^codestral|^devstral|^ministral|^mamba-codestral|^magistral/, folder: "mistral" },
  { test: /^nemotron-|^nim-/, folder: "nvidia" },
  { test: /^openrouter-/, folder: "openrouter" },
];

function inferFamily(modelKey) {
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(modelKey)) {
      return rule.folder;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run a child script
// ---------------------------------------------------------------------------

function runScript(scriptName) {
  const scriptPath = resolve(scriptDir, scriptName);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (signal) {
        rejectPromise(new Error(`${scriptName} exited with signal ${signal}`));
        return;
      }

      if (typeof code === "number" && code !== 0) {
        rejectPromise(new Error(`${scriptName} exited with code ${code}`));
        return;
      }

      resolvePromise();
    });
  });
}

// ---------------------------------------------------------------------------
// TOML sync — auto-create for mainstream, report obscure
// ---------------------------------------------------------------------------

function collectExistingModelIds() {
  const ids = new Set();

  for (const folder of readdirSync(modelsDir)) {
    const folderPath = join(modelsDir, folder);
    let entries;
    try {
      entries = readdirSync(folderPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.endsWith(".toml")) {
        ids.add(entry.slice(0, -".toml".length));
      }
    }
  }

  return ids;
}

function extractModelKeys(providerConfig) {
  const filePath = join(rootDir, providerConfig.file);
  const content = readFileSync(filePath, "utf8");
  const match = content.match(providerConfig.pattern);

  if (!match) {
    throw new Error(`Could not locate model map in ${providerConfig.file}`);
  }

  const entries = [...match[1].matchAll(/"([^"]+)":\s*"[^"]+",?/g)];
  return entries.map((entry) => entry[1]);
}

/** Returns a list of created TOML paths (relative, e.g. "models/meta/llama-4.toml"). */
function syncTomlRegistry() {
  const existingIds = collectExistingModelIds();

  // model key → set of provider names
  const missingModels = new Map();

  for (const provider of PROVIDERS) {
    let keys;
    try {
      keys = extractModelKeys(provider);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      continue;
    }

    for (const key of keys) {
      if (existingIds.has(key)) {
        continue;
      }

      const providers = missingModels.get(key) ?? new Set();
      providers.add(provider.name);
      missingModels.set(key, providers);
    }
  }

  if (missingModels.size === 0) {
    console.log("TOML registry is in sync with provider model maps.");
    return [];
  }

  const createdPaths = [];
  const skipped = [];

  for (const [modelKey, providerSet] of [...missingModels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const folder = inferFamily(modelKey);

    if (!folder) {
      skipped.push(modelKey);
      continue;
    }

    const folderPath = join(modelsDir, folder);

    if (!existsSync(folderPath)) {
      mkdirSync(folderPath, { recursive: true });
    }

    const providers = [...providerSet].sort();
    const content = `[opendum]\nproviders = [${providers.map((p) => `"${p}"`).join(", ")}]\n`;
    const filePath = join(folderPath, `${modelKey}.toml`);
    writeFileSync(filePath, content);
    console.log(`  created ${folder}/${modelKey}.toml`);
    createdPaths.push(`models/${folder}/${modelKey}.toml`);
  }

  if (createdPaths.length > 0) {
    console.log(`Created ${createdPaths.length} TOML file(s) for mainstream models.`);
  }

  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} obscure model(s): ${skipped.join(", ")}`);
  }

  return createdPaths;
}

// ---------------------------------------------------------------------------
// Snapshot & diff helpers — used to generate a dynamic PR summary
// ---------------------------------------------------------------------------

function snapshotModelKeys() {
  const snapshot = new Map();
  for (const provider of PROVIDERS) {
    try {
      snapshot.set(provider.name, new Set(extractModelKeys(provider)));
    } catch {
      snapshot.set(provider.name, new Set());
    }
  }
  return snapshot;
}

function generateSummary(before, after, createdTomls) {
  const added = [];
  const removed = [];

  for (const { name } of PROVIDERS) {
    const oldKeys = before.get(name) ?? new Set();
    const newKeys = after.get(name) ?? new Set();

    for (const key of newKeys) {
      if (!oldKeys.has(key)) added.push({ model: key, provider: name });
    }
    for (const key of oldKeys) {
      if (!newKeys.has(key)) removed.push({ model: key, provider: name });
    }
  }

  const sections = [];

  if (added.length) {
    const lines = added
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((e) => `- \`${e.model}\` *(${e.provider})*`);
    sections.push(`### Added Models (${added.length})\n\n${lines.join("\n")}`);
  }

  if (removed.length) {
    const lines = removed
      .sort((a, b) => a.model.localeCompare(b.model))
      .map((e) => `- \`${e.model}\` *(${e.provider})*`);
    sections.push(`### Removed Models (${removed.length})\n\n${lines.join("\n")}`);
  }

  if (createdTomls.length) {
    const lines = createdTomls.map((t) => `- \`${t}\``);
    sections.push(`### New TOML Definitions (${createdTomls.length})\n\n${lines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") + "\n" : "_No model changes detected._\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const before = snapshotModelKeys();

  const results = await Promise.allSettled(refreshScripts.map((scriptName) => runScript(scriptName)));
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    for (const failure of failures) {
      const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      console.error(reason);
    }

    process.exitCode = 1;
  }

  const createdTomls = syncTomlRegistry();

  const after = snapshotModelKeys();

  // Write PR summary when --summary <path> is passed
  const summaryIdx = process.argv.indexOf("--summary");
  if (summaryIdx !== -1 && process.argv[summaryIdx + 1]) {
    const summary = generateSummary(before, after, createdTomls);
    writeFileSync(process.argv[summaryIdx + 1], summary);
    console.log(`PR summary written to ${process.argv[summaryIdx + 1]}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
