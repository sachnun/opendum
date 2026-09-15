#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels } from "../src/registry.ts";
import { fetchText } from "../src/http.ts";
import { normalizeName } from "../src/similarity.ts";

const PROVIDER_NAME = "perch";

// Perch publishes the current Starter (free) pool on its models docs page
// (https://www.perchai.app/docs/concepts/models). That page is the live source
// of truth for which models a free account can pin; anything outside the
// Starter pool is Pro-only and paid, so it is intentionally never registered.
// The table only carries display names, so each name is resolved against the
// registry to reuse the canonical model id and the Perch pool alias already
// pinned for that model.
const PERCH_DOCS_URL = "https://www.perchai.app/docs/concepts/models";

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractStarterPoolNames(html) {
  const sectionStart = html.indexOf("Starter pool and its published rates:");
  if (sectionStart === -1) {
    throw new Error("Unable to locate the Perch Starter pool table in the docs page");
  }
  const sectionEnd = html.indexOf("The premium models", sectionStart);
  const section = sectionEnd === -1 ? html.slice(sectionStart) : html.slice(sectionStart, sectionEnd);

  const names = new Set();
  const rowPattern = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  for (const match of section.matchAll(rowPattern)) {
    const name = decodeHtmlEntities(match[1].trim()).replace(/<[^>]+>/g, "").trim();
    if (name && !name.startsWith("$")) {
      names.add(name);
    }
  }
  return [...names];
}

async function fetchStarterPoolNames() {
  const html = await fetchText(PERCH_DOCS_URL, {
    label: "Perch models docs",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; opendum-model-sync)" },
  });
  const names = extractStarterPoolNames(html);
  if (names.length === 0) {
    throw new Error("Perch Starter pool table is empty");
  }
  return names;
}

function perchUpstream(entry) {
  const upstream = entry.data.providerConfig?.perch?.upstream;
  return typeof upstream === "string" && upstream.trim() ? upstream.trim() : null;
}

function resolveStarterPool(modelsDir, docNames) {
  const byName = new Map();
  for (const entry of Object.values(buildModelIndex(modelsDir))) {
    const keys = [entry.fileId, entry.id, ...(entry.data.aliases || []), perchUpstream(entry)];
    for (const key of keys) {
      const normalized = key ? normalizeName(key) : "";
      if (normalized && !byName.has(normalized)) byName.set(normalized, entry);
    }
  }

  const modelMap = new Map();
  const unresolved = [];
  for (const docName of docNames) {
    const entry = byName.get(normalizeName(docName));
    if (!entry) {
      unresolved.push(docName);
      continue;
    }
    const alias = perchUpstream(entry) ?? normalizeName(docName);
    if (modelMap.has(entry.fileId) && modelMap.get(entry.fileId) !== alias) {
      throw new Error(`Duplicate Perch Starter mapping for ${entry.fileId}`);
    }
    modelMap.set(entry.fileId, alias);
  }
  return {
    modelMap: new Map([...modelMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    unresolved,
  };
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const docNames = await fetchStarterPoolNames();
  const { modelMap, unresolved } = resolveStarterPool(modelsDir, docNames);
  if (unresolved.length > 0) {
    console.warn(`[perch] Skipped Starter model(s) absent from the registry: ${unresolved.join(", ")}`);
  }

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Perch Starter models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Perch: ${modelMap.size} Starter models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
