#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModelIndex, syncProviderModels } from "#models/registry.ts";
import { fetchText, fetchJson } from "#models/http.ts";
import { normalizeKey, normalizeName } from "#models/similarity.ts";
import { syncCliVersion } from "./version-sync.ts";

const PROVIDER_NAME = "perch";

// Perch publishes the current Starter (free) pool on its models docs page
// (https://www.perchai.app/docs/concepts/models). That page is the live source
// of truth for which models a free account can pin; anything outside the
// Starter pool is Pro-only and paid, so it is intentionally never registered.
// The Starter table carries the display name plus the Perch CLI command
// (/model <alias>), so the command is reused as the Perch upstream alias and
// the display name is resolved against the registry to find the canonical id.
const PERCH_DOCS_URL = "https://www.perchai.app/docs/concepts/models";
const PERCH_CLI_NPM_URL = "https://registry.npmjs.org/perchai-cli/latest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const PERCH_CLI_VERSION_TARGETS = [
  {
    label: "perch provider",
    path: resolve(REPO_ROOT, "packages/providers/src/perch.ts"),
    pattern: /(const PERCH_CLI_VERSION = ")(\d+\.\d+\.\d+)(")/,
  },
];

async function syncCliVersionFromNpm() {
  const metadata = await fetchJson(PERCH_CLI_NPM_URL, { label: "perchai-cli npm metadata" });
  const latestVersion = metadata?.version;
  if (typeof latestVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    console.warn("[perch] Could not determine the latest CLI version from npm, skipping.");
    return;
  }
  syncCliVersion("perch", PERCH_CLI_VERSION_TARGETS, latestVersion);
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(text) {
  return decodeHtmlEntities(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Locate the Starter table by its header instead of a prose anchor: the docs
// page has been reworded more than once, but the "Desktop and CLI command"
// column is what makes this table the selectable Starter pool.
function extractStarterPool(html) {
  for (const tableMatch of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const table = tableMatch[1];
    const headerEnd = table.indexOf("</thead>");
    const header = headerEnd === -1 ? table : table.slice(0, headerEnd);
    if (!/Desktop and CLI command/i.test(header)) continue;

    const bodyStart = table.indexOf("<tbody");
    const bodyEnd = table.indexOf("</tbody>", bodyStart);
    const body = bodyStart === -1 ? table : table.slice(bodyStart, bodyEnd);

    const rows = [];
    for (const rowMatch of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => stripHtml(cell[1]));
      if (cells.length < 3) continue;
      const name = cells[0];
      const command = cells[2].match(/\/model\s+(\S+)/i)?.[1];
      if (!name || !command) continue;
      rows.push({ name, command });
    }
    if (rows.length > 0) return rows;
  }
  throw new Error("Unable to locate the Perch Starter model table in the docs page");
}

async function fetchStarterPool() {
  const html = await fetchText(PERCH_DOCS_URL, {
    label: "Perch models docs",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; opendum-model-sync)" },
  });
  const rows = extractStarterPool(html);
  if (rows.length === 0) {
    throw new Error("Perch Starter model table is empty");
  }
  return rows;
}

function perchUpstream(entry) {
  const upstream = entry.data.providerConfig?.perch?.upstream;
  return typeof upstream === "string" && upstream.trim() ? upstream.trim() : null;
}

function compactName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripTrailingDate(value) {
  return value.replace(/[\s_-]+\d{4,8}$/, "").trim();
}

function buildLookup(modelsDir) {
  const byCompact = new Map();
  const byNormalized = new Map();

  const register = (map, key, entry) => {
    if (!key) return;
    if (map.has(key)) {
      if (map.get(key) !== entry) map.set(key, null);
      return;
    }
    map.set(key, entry);
  };

  for (const entry of Object.values(buildModelIndex(modelsDir))) {
    const keys = [entry.fileId, entry.id, ...(entry.data.aliases || []), perchUpstream(entry)];
    for (const key of keys) {
      if (typeof key !== "string" || !key.trim()) continue;
      register(byCompact, compactName(key), entry);
      register(byNormalized, normalizeName(key), entry);
      register(byNormalized, normalizeKey(key), entry);
    }
  }

  return { byCompact, byNormalized };
}

function resolveStarterPool(modelsDir, rows) {
  const { byCompact, byNormalized } = buildLookup(modelsDir);

  const modelMap = new Map();
  const unresolved = [];
  for (const row of rows) {
    const candidates = [row.command, row.name, stripTrailingDate(row.name)];
    let entry = null;
    for (const candidate of candidates) {
      entry =
        byCompact.get(compactName(candidate)) ??
        byNormalized.get(normalizeName(candidate)) ??
        byNormalized.get(normalizeKey(candidate)) ??
        null;
      if (entry) break;
    }
    if (!entry) {
      unresolved.push(row.name);
      continue;
    }
    if (modelMap.has(entry.fileId) && modelMap.get(entry.fileId) !== row.command) {
      throw new Error(`Duplicate Perch Starter mapping for ${entry.fileId}`);
    }
    modelMap.set(entry.fileId, row.command);
  }

  return {
    modelMap: new Map([...modelMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    unresolved,
  };
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const modelsDir = resolve(scriptDir, "../data");

  const rows = await fetchStarterPool();
  const { modelMap, unresolved } = resolveStarterPool(modelsDir, rows);
  if (unresolved.length > 0) {
    console.warn(`[perch] Skipped Starter model(s) absent from the registry: ${unresolved.join(", ")}`);
  }

  const result = syncProviderModels(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Perch Starter models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(`Perch: ${modelMap.size} Starter models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`);
  }

  await syncCliVersionFromNpm().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[perch] CLI version sync failed (${message})`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
