import { sync } from "#models/model-store.ts";
import { runFetchText, runFetchJson } from "#models/sync/http.ts";
import { stripParams } from "#models/model/clean-key.ts";
import { arrayAt, trimmed, stringAt } from "#models/json.ts";
import { syncCli } from "./version-sync.ts";
import { join } from "#models/paths.ts";
import { packageVersion, dataDir, repoRoot, runScript } from "./shared.ts";
import type { JsonValue } from "#models/types.ts";

const OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models";
const ZEN_DOCS_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/models.mdx";
const OPENCODE_NPM_PACKAGE = "opencode-ai";

const REPO_ROOT = repoRoot();

const OPENCODE_VERSION_TARGETS = [
  {
    label: "opencode provider",
    path: join(REPO_ROOT, "packages/providers/upstreams/opencode.ts"),
    pattern: /(const USER_AGENT = "opencode\/)(\d+\.\d+\.\d+)(")/,
  },
  {
    label: "opencode provider test",
    path: join(REPO_ROOT, "packages/providers/upstreams/opencode.test.ts"),
    pattern: /(toBe\("opencode\/)(\d+\.\d+\.\d+)(")/,
  },
  {
    label: "codex provider",
    path: join(REPO_ROOT, "packages/providers/upstreams/codex.ts"),
    pattern: /(User-Agent": `opencode\/)(\d+\.\d+\.\d+)( \()/,
  },
  {
    label: "codex quota fetcher",
    path: join(REPO_ROOT, "packages/providers/quota/fetchers/codex.ts"),
    pattern: /(User-Agent": `opencode\/)(\d+\.\d+\.\d+)( \()/,
  },
  {
    label: "codex web constants",
    path: join(REPO_ROOT, "apps/api/web/lib/providers/codex/constants.ts"),
    pattern: /(const OPENCODE_VERSION = ")(\d+\.\d+\.\d+)(")/,
  },
];

interface MarkdownTable {
  headers: string[];
  body: string[][];
}

interface DocsFreeModels {
  freeModels: string[];
  endpointByModel: Map<string, string>;
}

async function userAgent(): Promise<void> {
  const latestVersion = await packageVersion(OPENCODE_NPM_PACKAGE).catch(() => null);
  if (!latestVersion || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    console.warn("Opencode: could not determine latest version from unpkg, skipping.");
    return;
  }
  syncCli("Opencode", OPENCODE_VERSION_TARGETS, latestVersion);
}

function toKey(modelId: string): string {
  const cleaned = stripParams(modelId);
  if (cleaned.endsWith("-free")) return cleaned.slice(0, -"-free".length);
  return cleaned;
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/`/g, "").trim());
}

function parseTables(markdown: string): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = lines[i] ?? "";
    const separator = lines[i + 1] ?? "";
    if (!line.trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}:?\s*\|/.test(separator)) continue;

    const rows: string[] = [];
    for (let j = i; j < lines.length && (lines[j] ?? "").trim().startsWith("|"); j += 1) {
      rows.push(lines[j] ?? "");
      i = j;
    }

    const headers = splitRow(rows[0] ?? "");
    const body = rows.slice(2).map((row) => splitRow(row));
    tables.push({ headers, body });
  }

  return tables;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
}

function nameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function cell(row: string[], index: number): string {
  return index < 0 ? "" : (row[index] ?? "");
}

function extractFree(markdown: string): DocsFreeModels {
  const tables = parseTables(markdown);
  const endpointsTable = tables.find(
    (table) =>
      headerIndex(table.headers, "Model ID") !== -1 && headerIndex(table.headers, "Endpoint") !== -1
  );
  const pricingTable = tables.find(
    (table) =>
      headerIndex(table.headers, "Input") !== -1 &&
      headerIndex(table.headers, "Output") !== -1 &&
      headerIndex(table.headers, "Cached Read") !== -1
  );

  if (!endpointsTable || !pricingTable) {
    throw new Error(
      "Unexpected OpenCode Console docs format: model endpoint or pricing table not found"
    );
  }

  const endpointModelIndex = headerIndex(endpointsTable.headers, "Model");
  const endpointIndex = headerIndex(endpointsTable.headers, "Model ID");
  const endpointUrlIndex = headerIndex(endpointsTable.headers, "Endpoint");
  const pricingModelIndex = headerIndex(pricingTable.headers, "Model");
  const pricingInputIndex = headerIndex(pricingTable.headers, "Input");
  const pricingOutputIndex = headerIndex(pricingTable.headers, "Output");
  const cachedReadIndex = headerIndex(pricingTable.headers, "Cached Read");

  const idsByName = new Map<string, string>();
  const endpointByModel = new Map<string, string>();

  for (const row of endpointsTable.body) {
    const modelName = cell(row, endpointModelIndex);
    const modelId = cell(row, endpointIndex);
    const endpoint = cell(row, endpointUrlIndex);
    if (modelName && modelId) idsByName.set(nameKey(modelName), modelId);
    if (modelId && endpoint) endpointByModel.set(modelId, endpoint);
  }

  const modelIds: string[] = [];
  for (const row of pricingTable.body) {
    const isFree = [
      cell(row, pricingInputIndex),
      cell(row, pricingOutputIndex),
      cell(row, cachedReadIndex),
    ].every((value) => value.toLowerCase() === "free");
    if (!isFree) continue;

    const modelName = cell(row, pricingModelIndex);
    const modelId = idsByName.get(nameKey(modelName));
    if (!modelId) {
      throw new Error(
        `OpenCode Console docs pricing model is missing from endpoint table: ${modelName}`
      );
    }
    modelIds.push(modelId);
  }

  if (modelIds.length === 0) {
    throw new Error("OpenCode Console docs did not list any free models");
  }

  return {
    freeModels: modelIds.sort((a, b) => a.localeCompare(b)),
    endpointByModel,
  };
}

async function freeDocs(): Promise<DocsFreeModels> {
  const [docsMarkdown, modelsPayload] = await Promise.all([
    runFetchText(ZEN_DOCS_URL, { label: "OpenCode Console docs" }),
    runFetchJson(OPENCODE_MODELS_URL, { label: "OpenCode model list" }),
  ]);

  const models = arrayAt(modelsPayload, "data");
  if (models.length === 0) {
    throw new Error("Unexpected Opencode /zen/v1/models payload format");
  }

  const availableModelIds = new Set(
    models.flatMap((model) => {
      const id = trimmed(stringAt(model, "id"));
      return id ? [id] : [];
    })
  );

  const { freeModels, endpointByModel } = extractFree(docsMarkdown);
  const missingModelIds = freeModels.filter((id) => !availableModelIds.has(id));

  if (missingModelIds.length > 0) {
    console.warn(
      `Opencode: docs list free models missing from /zen/v1/models, skipping: ${missingModelIds.join(", ")}`
    );
  }

  return {
    freeModels: freeModels.filter((id) => availableModelIds.has(id)),
    endpointByModel,
  };
}

function modelIndex(modelIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const modelId of modelIds) {
    const modelKey = toKey(modelId);
    if (!map.has(modelKey)) map.set(modelKey, modelId);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function configOf(
  modelMap: Map<string, string>,
  endpointByModel: Map<string, string>
): Map<string, Record<string, JsonValue>> {
  const configByModel = new Map<string, Record<string, JsonValue>>();

  for (const [modelKey, modelId] of modelMap.entries()) {
    const endpoint = endpointByModel.get(modelId) ?? "";
    if (endpoint.includes("/responses")) {
      configByModel.set(modelKey, { responses_api: true });
    } else if (endpoint.includes("/messages")) {
      configByModel.set(modelKey, { messages_api: true });
    }
  }

  return configByModel;
}

async function main(): Promise<void> {
  const modelsDir = dataDir();

  const { freeModels, endpointByModel } = await freeDocs();
  const modelMap = modelIndex(freeModels);
  const providerConfig = configOf(modelMap, endpointByModel);

  const result = await sync(modelsDir, "opencode", modelMap, {
    providerConfig,
    managedProviderConfigKeys: ["responses_api", "messages_api"],
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Opencode free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Opencode: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }

  await userAgent().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Opencode: User-Agent sync failed (${message})`);
  });
}

runScript(main);
