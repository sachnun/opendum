import { sync } from "#models/model-store.ts";
import { fetchDecoded, runFetchText, FETCH_TIMEOUT_MS, runOrThrow } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { syncCliVersion } from "./version-sync.ts";
import { join } from "#models/paths.ts";
import { flags, packageModelsDir, repoRoot, runScript } from "./shared.ts";

const KIRO_DOCS_URL = "https://kiro.dev/docs/models/";
const KIRO_DOWNLOADS_URL = "https://kiro.dev/downloads/";
const PROVIDER_NAME = "kiro";

const REPO_ROOT = repoRoot();

const KIRO_IDE_VERSION_TARGETS = [
  {
    label: "kiro provider",
    path: join(REPO_ROOT, "packages/providers/upstreams/kiro/index.ts"),
    pattern: /(KiroIDE-)(\d+\.\d+\.\d+)(")/,
  },
  {
    label: "kiro quota fetcher",
    path: join(REPO_ROOT, "packages/providers/quota/fetchers/kiro.ts"),
    pattern: /(KiroIDE-)(\d+\.\d+\.\d+)(")/,
  },
];

interface OfficialModel {
  name: string;
  contextWindow: string;
  region: string;
  freeAvailable: boolean;
  paidAvailable: boolean;
}

function parseLatestIdeVersion(html: string): string | null {
  const labelMatch = html.match(/IDE\s+(\d+\.\d+\.\d+)\s*Latest/);
  if (labelMatch) return labelMatch[1];
  const downloadMatch = html.match(/kiro-ide-(\d+\.\d+\.\d+)-stable/);
  return downloadMatch ? downloadMatch[1] : null;
}

async function syncIdeVersion() {
  const html = await runFetchText(KIRO_DOWNLOADS_URL, {
    label: "Kiro downloads page",
    headers: { Accept: "text/html" },
  });
  syncCliVersion("kiro", KIRO_IDE_VERSION_TARGETS, parseLatestIdeVersion(html));
}

function isIgnoredDisplayName(name: string): boolean {
  return !/[0-9]/.test(name);
}

const PAID_KIRO_TIERS = ["pro", "pro+", "power", "standalone"];

const MODELS_WITH_1M_VARIANT = new Set([
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
]);

function stripHtml(html: string): string {
  return html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function fetchOfficialModels() {
  return runOrThrow(
    fetchDecoded(
      KIRO_DOCS_URL,
      { label: "Kiro docs", headers: { Accept: "text/html" } },
      async (response) => parseModelsFromHtml(await response.text())
    )
  );
}

function parseModelsFromHtml(html: string): OfficialModel[] {
  const tables: string[] = [];
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    tables.push(tableMatch[1]);
  }

  if (tables.length === 0) {
    throw new Error(
      "No tables found on Kiro docs page. The page structure may have changed."
    );
  }

  let comparisonTable = null;
  for (const table of tables) {
    const candidateRows = parseTableRows(table);
    if (candidateRows.length === 0) continue;

    const candidateHeader = candidateRows[0].map((h) => h.toLowerCase());
    const hasModel = candidateHeader.some(
      (h) => h === "model" || h.includes("model")
    );
    const hasContext = candidateHeader.some((h) => h.includes("context"));

    if (hasModel && hasContext) {
      comparisonTable = table;
      break;
    }
  }

  if (!comparisonTable) {
    throw new Error(
      'Could not find "Quick comparison" table on Kiro docs page. ' +
        "The page structure may have changed."
    );
  }

  const rows = parseTableRows(comparisonTable);
  if (rows.length < 2) {
    throw new Error("Models table has fewer than 2 rows (header + data).");
  }

  const header = rows[0].map((h) => h.toLowerCase());
  const nameIdx = header.findIndex(
    (h) => h === "model" || h.includes("model")
  );
  const ctxIdx = header.findIndex((h) => h.includes("context"));
  const regionIdx = header.findIndex((h) => h.includes("region"));
  const freeIdx = header.findIndex((h) => h === "free");
  const proIdx = header.findIndex((h) => h === "pro");
  const proPlusIdx = header.findIndex((h) => h === "pro+" || h === "pro plus" || (h.startsWith("pro") && h.includes("+")));
  const powerIdx = header.findIndex((h) => h === "power");

  if (nameIdx < 0) {
    throw new Error("Could not find 'Model' column in comparison table.");
  }

  const models: OfficialModel[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const name = row[nameIdx]?.trim();
    if (!name) continue;

    const freeCell = freeIdx >= 0 ? (row[freeIdx]?.trim() || "") : "";
    const proCell = proIdx >= 0 ? (row[proIdx]?.trim() || "") : "";
    const proPlusCell = proPlusIdx >= 0 ? (row[proPlusIdx]?.trim() || "") : "";
    const powerCell = powerIdx >= 0 ? (row[powerIdx]?.trim() || "") : "";

    const freeAvailable = freeCell.length > 0;

    const paidAvailable = proCell.length > 0 || proPlusCell.length > 0 || powerCell.length > 0;

    models.push({
      name,
      contextWindow: ctxIdx >= 0 ? (row[ctxIdx]?.trim() || "") : "",
      region: regionIdx >= 0 ? (row[regionIdx]?.trim() || "") : "",
      freeAvailable,
      paidAvailable,
    });
  }

  if (models.length === 0) {
    throw new Error("No models found in comparison table.");
  }

  return models;
}

function parseTableRows(tableInnerHtml: string): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(tableInnerHtml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch;

    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(stripHtml(cellMatch[1]));
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  return rows;
}

async function fetchDocsCatalog() {
  let html: string;
  try {
    const response = await fetch(KIRO_DOCS_URL, {
      headers: { Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return new Map();
    html = await response.text();
  } catch {
    return new Map();
  }

  const chunkPaths: string[] = [
    ...new Set([...html.matchAll(/\/_next\/static\/chunks\/[a-zA-Z0-9._-]+\.js/g)].map((m) => m[0])),
  ];
  const byName = new Map<string, string>();

  for (const chunkPath of chunkPaths) {
    let script: string;
    try {
      const response = await fetch(new URL(chunkPath, KIRO_DOCS_URL), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      script = await response.text();
    } catch {
      continue;
    }

    for (const match of script.matchAll(/\{"id":"([a-z0-9.-]+)","name":"([^"]+)","provider":"[^"]+"/g)) {
      if (!byName.has(match[2])) byName.set(match[2], match[1]);
    }
  }

  return byName;
}

function displayNameToKiroId(displayName: string, catalog: Map<string, string>): string {
  const published = catalog?.get(displayName);
  if (published) return published;

  let id = displayName.toLowerCase().replace(/\s+/g, "-");

  id = id.replace(/\.0(?=-|$)/g, "");

  id = id.replace(/^minimax-(\d)/, "minimax-m$1");

  return id;
}

function expandVariants(kiroId: string): string[] {
  const ids = [kiroId];

  if (MODELS_WITH_1M_VARIANT.has(kiroId)) {
    ids.push(`${kiroId}-1m`);
  }

  return ids;
}

function toCanonical(kiroModelId: string): { key: string; upstream: string } {
  let key = kiroModelId;

  if (key.startsWith("claude-")) {
    key = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  }

  if (key.startsWith("deepseek-") && /^deepseek-\d/.test(key)) {
    key = key.replace(/^deepseek-/, "deepseek-v");
  }

  key = stripParamInfoKey(key).replace(/[^a-z0-9.-]/g, "");

  return { key, upstream: kiroModelId };
}

async function main(): Promise<void> {
  const { dryRun, verbose } = flags();

  console.log(`[kiro] Fetching models from ${KIRO_DOCS_URL} ...`);
  const officialModels = await fetchOfficialModels();
  console.log(
    `[kiro] Found ${officialModels.length} models on docs page: ${officialModels.map((m) => m.name).join(", ")}`
  );

  const catalog = await fetchDocsCatalog();
  console.log(`[kiro] Resolved ${catalog.size} published model IDs from the docs bundle.`);

  const paidOnlyDisplayNames = new Set(
    officialModels
      .filter((m) => !isIgnoredDisplayName(m.name) && !m.freeAvailable && m.paidAvailable)
      .map((m) => m.name)
  );

  if (verbose || dryRun) {
    const freeModels = officialModels.filter((m) => !isIgnoredDisplayName(m.name) && m.freeAvailable);
    const paidModels = officialModels.filter((m) => paidOnlyDisplayNames.has(m.name));
    console.log(`\n[kiro] Tier breakdown:`);
    console.log(`  Free models (${freeModels.length}): ${freeModels.map((m) => m.name).join(", ")}`);
    console.log(`  Paid-only models (${paidModels.length}): ${paidModels.map((m) => m.name).join(", ")}`);
    console.log();
  }

  const allKiroIds: string[] = [];
  for (const model of officialModels) {
    if (isIgnoredDisplayName(model.name)) {
      if (verbose) {
        console.log(`[kiro] Skipping "${model.name}" (ignored)`);
      }
      continue;
    }

    const baseId = displayNameToKiroId(model.name, catalog);
    const variants = expandVariants(baseId);
    allKiroIds.push(...variants);

    if (verbose) {
      console.log(
        `[kiro]   "${model.name}" → ${variants.join(", ")}` +
          (model.region ? ` (${model.region})` : "")
      );
    }
  }

  console.log(`[kiro] Generated ${allKiroIds.length} Kiro API model IDs.`);

  const modelMap = new Map<string, string>();
  for (const kiroId of allKiroIds) {
    const { key, upstream } = toCanonical(kiroId);
    modelMap.set(key, upstream);
  }

  console.log(`[kiro] Mapped to ${modelMap.size} canonical model keys.`);

  if (verbose || dryRun) {
    console.log("\n[kiro] Model mapping (canonical → upstream):");
    for (const [key, upstream] of [...modelMap.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}${key !== upstream ? ` → ${upstream}` : ""}`);
    }
    console.log();
  }

  const providerConfigByModel = new Map<string, { allowedTiers: string[] }>();
  for (const model of officialModels) {
    if (isIgnoredDisplayName(model.name)) continue;
    if (!paidOnlyDisplayNames.has(model.name)) continue;

    const baseId = displayNameToKiroId(model.name, catalog);
    const variants = expandVariants(baseId);
    for (const kiroId of variants) {
      const { key } = toCanonical(kiroId);
      providerConfigByModel.set(key, { allowedTiers: PAID_KIRO_TIERS });
    }
  }

  if (verbose || dryRun) {
    console.log("\n[kiro] Provider config by model (allowedTiers):");
    for (const [key, config] of [...providerConfigByModel.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`  ${key}: allowedTiers = [${config.allowedTiers.join(", ")}]`);
    }
    console.log();
  }

  if (dryRun) {
    console.log("[kiro] Dry run - no JSON files modified.");
    return;
  }

  const modelsDir = packageModelsDir();

  const result = await sync(modelsDir, PROVIDER_NAME, modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["allowedTiers"],
  });

  if (
    result.added.length === 0 &&
    result.removed.length === 0 &&
    result.updated.length === 0
  ) {
    console.log(
      `[kiro] Models are already up to date (${modelMap.size} models).`
    );
  } else {
    console.log(
      `[kiro] Synced ${modelMap.size} models ` +
        `(added: ${result.added.length}, removed: ${result.removed.length}, updated: ${result.updated.length}).`
    );
    if (result.added.length > 0) {
      console.log(`  Added: ${result.added.join(", ")}`);
    }
    if (result.removed.length > 0) {
      console.log(`  Removed: ${result.removed.join(", ")}`);
    }
    if (result.updated.length > 0) {
      console.log(`  Updated: ${result.updated.join(", ")}`);
    }
  }

  await syncIdeVersion().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[kiro] IDE version sync failed (${message})`);
  });
}

runScript(main);
