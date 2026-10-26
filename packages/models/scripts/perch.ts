import { buildIndex, sync } from "#models/model-store.ts";
import { fetchText } from "#models/sync/http.ts";
import { normalizeKey, normalizeName } from "#models/model/similarity.ts";
import { syncCli as syncTargets } from "./version-sync.ts";
import { join } from "#models/paths.ts";
import { packageVersion, dataDir, repoRoot, runScript } from "./shared.ts";
import type { ModelIndexEntry } from "#models/types.ts";

const PROVIDER_NAME = "perch";

const PERCH_DOCS_URL = "https://www.perchai.app/docs/concepts/models";
const CLI_PACKAGE = "perchai-cli";

const REPO_ROOT = repoRoot();

const CLI_TARGETS = [
  {
    label: "perch provider",
    path: join(REPO_ROOT, "packages/providers/upstreams/perch.ts"),
    pattern: /(const PERCH_CLI_VERSION = ")(\d+\.\d+\.\d+)(")/,
  },
];

interface StarterRow {
  name: string;
  command: string;
}

async function syncCli(): Promise<void> {
  const latestVersion = await packageVersion(CLI_PACKAGE).catch(() => null);
  if (!latestVersion || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    console.warn("[perch] Could not determine the latest CLI version from unpkg, skipping.");
    return;
  }
  syncTargets("perch", CLI_TARGETS, latestVersion);
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(text: string): string {
  return decodeHtml(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPool(html: string): StarterRow[] {
  for (const tableMatch of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)) {
    const table = tableMatch[1] ?? "";
    const headerEnd = table.indexOf("</thead>");
    const header = headerEnd === -1 ? table : table.slice(0, headerEnd);
    if (!/Desktop and CLI command/i.test(header)) continue;

    const bodyStart = table.indexOf("<tbody");
    const bodyEnd = table.indexOf("</tbody>", bodyStart);
    const body = bodyStart === -1 ? table : table.slice(bodyStart, bodyEnd);

    const rows: StarterRow[] = [];
    for (const rowMatch of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) =>
        stripHtml(cell[1] ?? "")
      );
      if (cells.length < 3) continue;
      const name = cells[0];
      const command = cells[2]?.match(/\/model\s+(\S+)/i)?.[1];
      if (!name || !command) continue;
      rows.push({ name, command });
    }
    if (rows.length > 0) return rows;
  }
  throw new Error("Unable to locate the Perch Starter model table in the docs page");
}

async function fetchPool(): Promise<StarterRow[]> {
  const html = await fetchText(PERCH_DOCS_URL, {
    label: "Perch models docs",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; opendum-model-sync)" },
  });
  const rows = extractPool(html);
  if (rows.length === 0) {
    throw new Error("Perch Starter model table is empty");
  }
  return rows;
}

function perchUpstream(entry: ModelIndexEntry): string | null {
  const upstream = entry.data.providerConfig?.[PROVIDER_NAME]?.upstream;
  return typeof upstream === "string" && upstream.trim() ? upstream.trim() : null;
}

function compactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripDate(value: string): string {
  return value.replace(/[\s_-]+\d{4,8}$/, "").trim();
}

type Lookup = Map<string, ModelIndexEntry | null>;

function register(map: Lookup, key: string, entry: ModelIndexEntry): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, entry);
    return;
  }
  if (existing !== entry) map.set(key, null);
}

function buildLookup(modelsDir: string): { byCompact: Lookup; byNormalized: Lookup } {
  const byCompact: Lookup = new Map();
  const byNormalized: Lookup = new Map();

  for (const entry of Object.values(buildIndex(modelsDir))) {
    const keys = [entry.fileId, entry.id, ...(entry.data.aliases ?? []), perchUpstream(entry)];
    for (const key of keys) {
      if (typeof key !== "string" || !key.trim()) continue;
      register(byCompact, compactName(key), entry);
      register(byNormalized, normalizeName(key), entry);
      register(byNormalized, normalizeKey(key), entry);
    }
  }

  return { byCompact, byNormalized };
}

function starterPool(
  modelsDir: string,
  rows: StarterRow[]
): { modelMap: Map<string, string>; unresolved: string[] } {
  const { byCompact, byNormalized } = buildLookup(modelsDir);

  const modelMap = new Map<string, string>();
  const unresolved: string[] = [];

  for (const row of rows) {
    const candidates = [row.command, row.name, stripDate(row.name)];
    let entry: ModelIndexEntry | null = null;
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
    const existing = modelMap.get(entry.fileId);
    if (existing !== undefined && existing !== row.command) {
      throw new Error(`Duplicate Perch Starter mapping for ${entry.fileId}`);
    }
    modelMap.set(entry.fileId, row.command);
  }

  return {
    modelMap: new Map([...modelMap.entries()].sort(([a], [b]) => a.localeCompare(b))),
    unresolved,
  };
}

async function main(): Promise<void> {
  const modelsDir = dataDir();

  const rows = await fetchPool();
  const { modelMap, unresolved } = starterPool(modelsDir, rows);
  if (unresolved.length > 0) {
    console.warn(`[perch] Skipped Starter model(s) absent from the registry: ${unresolved.join(", ")}`);
  }

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap);

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Perch Starter models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Perch: ${modelMap.size} Starter models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }

  await syncCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[perch] CLI version sync failed (${message})`);
  });
}

runScript(main);
