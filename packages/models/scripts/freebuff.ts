#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { syncProviderModels } from "../src/registry.ts";
import { fetchText } from "../src/http.ts";
import { stripParamInfoKey } from "../src/clean-key.ts";

const PROVIDER_NAME = "freebuff";
const RAW_BASE = "https://raw.githubusercontent.com/CodebuffAI/codebuff/main/common/src/constants";
const AGENTS_URL = `${RAW_BASE}/free-agents.ts`;
const CONSTANT_URLS = [
  `${RAW_BASE}/freebuff-models.ts`,
  `${RAW_BASE}/freebuff-model-ids.ts`,
  `${RAW_BASE}/freebuff-model-entitlements.ts`,
  `${RAW_BASE}/model-config.ts`,
];

const MIN_EXPECTED_MODELS = 3;

function toModelKey(modelId) {
  const base = modelId.slice(modelId.lastIndexOf("/") + 1);
  return stripParamInfoKey(base.replace(/[:/]/g, "-").replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-{2,}/g, "-"));
}

function parseConstants(source) {
  const exprs = new Map();
  const members = new Map();
  const declaration = /export const ([A-Za-z0-9_]+)\s*=\s*([\s\S]*?)(?=\nexport |\nconst |\nfunction |\n\/\*\*|$)/g;
  let match;
  while ((match = declaration.exec(source)) !== null) {
    const [, name, body] = match;
    if (body.trimStart().startsWith("{")) {
      for (const entry of body.matchAll(/([A-Za-z0-9_]+)\s*:\s*('([^']+)'|[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?)/g)) {
        members.set(`${name}.${entry[1]}`, entry[3] ?? entry[2]);
      }
      continue;
    }
    exprs.set(name, body.trim());
  }
  return { exprs, members };
}

function makeResolver({ exprs, members }) {
  const memo = new Map();
  function resolveExpr(expr) {
    if (!expr) return null;
    const trimmed = expr.trim().replace(/;$/, "");
    const literal = trimmed.match(/^'([^']+)'$/);
    if (literal) return literal[1];
    const member = trimmed.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);
    if (member) {
      const key = `${member[1]}.${member[2]}`;
      if (members.has(key)) return members.get(key);
      return null;
    }
    return resolveName(trimmed);
  }
  function resolveName(name) {
    if (memo.has(name)) return memo.get(name);
    memo.set(name, null);
    const value = exprs.has(name) ? resolveExpr(exprs.get(name)) : null;
    memo.set(name, value);
    return value;
  }
  return resolveName;
}

function parseRootAgentByModel(source, resolveName) {
  const start = source.indexOf("FREEBUFF_ROOT_AGENT_ID_BY_MODEL");
  if (start === -1) throw new Error("FREEBUFF_ROOT_AGENT_ID_BY_MODEL not found");
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  const block = source.slice(open + 1, close);
  const map = new Map();
  const entry = /(?:\[([A-Z0-9_]+)\]|'([^']+)')\s*:\s*'([^']+)'/g;
  let match;
  while ((match = entry.exec(block)) !== null) {
    const [, constantName, literalModel, agent] = match;
    const modelId = literalModel ?? resolveName(constantName);
    if (!modelId) continue;
    map.set(modelId, agent);
  }
  return map;
}

async function main() {
  const [agentsSource, ...constantSources] = await Promise.all([
    fetchText(AGENTS_URL, { label: "Codebuff free-agents.ts" }),
    ...CONSTANT_URLS.map((url) => fetchText(url, { label: url })),
  ]);

  const exprs = new Map();
  const members = new Map();
  for (const source of constantSources) {
    const parsed = parseConstants(source);
    for (const [key, value] of parsed.exprs) exprs.set(key, value);
    for (const [key, value] of parsed.members) members.set(key, value);
  }
  const resolveName = makeResolver({ exprs, members });

  const byModel = parseRootAgentByModel(agentsSource, resolveName);
  if (byModel.size === 0) throw new Error("Codebuff free root agent map is empty");
  if (byModel.size < MIN_EXPECTED_MODELS) {
    console.warn(`Freebuff root agent map has only ${byModel.size} models (expected >= ${MIN_EXPECTED_MODELS})`);
  }

  const modelMap = new Map();
  const providerConfigByModel = new Map();
  for (const [modelId, agent] of byModel) {
    const modelKey = toModelKey(modelId);
    modelMap.set(modelKey, modelId);
    providerConfigByModel.set(modelKey, { upstream: modelId, agent });
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["upstream", "agent"],
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Freebuff models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Freebuff: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
