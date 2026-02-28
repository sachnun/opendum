#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const modelsDir = join(rootDir, "models");

const refreshScripts = [
  "refresh-openrouter-free-models.mjs",
  "refresh-nvidia-nim-models.mjs",
  "refresh-ollama-cloud-models.mjs",
];

// ---------------------------------------------------------------------------
// Provider constants paths & regex (for TOML sync)
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
// Model key → folder inference
// ---------------------------------------------------------------------------

const FOLDER_RULES = [
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

function inferFolder(modelKey) {
  for (const rule of FOLDER_RULES) {
    if (rule.test.test(modelKey)) {
      return rule.folder;
    }
  }
  return "other";
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
// TOML sync — create skeleton files for models in provider maps without one
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

function syncTomlRegistry() {
  const existingIds = collectExistingModelIds();
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
    return;
  }

  let created = 0;

  for (const [modelKey, providerSet] of [...missingModels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const folder = inferFolder(modelKey);
    const folderPath = join(modelsDir, folder);

    if (!existsSync(folderPath)) {
      mkdirSync(folderPath, { recursive: true });
    }

    const providers = [...providerSet].sort();
    const content = `[opendum]\nproviders = [${providers.map((p) => `"${p}"`).join(", ")}]\n`;
    const filePath = join(folderPath, `${modelKey}.toml`);
    writeFileSync(filePath, content);
    console.log(`  created ${folder}/${modelKey}.toml`);
    created += 1;
  }

  console.log(`Created ${created} skeleton TOML file(s).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Phase 1: refresh all provider model maps in parallel
  const results = await Promise.allSettled(refreshScripts.map((scriptName) => runScript(scriptName)));
  const failures = results.filter((result) => result.status === "rejected");

  if (failures.length > 0) {
    for (const failure of failures) {
      const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
      console.error(reason);
    }

    process.exitCode = 1;
  }

  // Phase 2: create skeleton TOML files for any new models
  syncTomlRegistry();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
