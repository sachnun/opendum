import { sync } from "#models/model-store.ts";
import { runFetchText, runFetchJson } from "#models/sync/http.ts";
import { stripParamInfoKey } from "#models/model/clean-key.ts";
import { arrayAt, asTrimmedString, stringAt } from "#models/json.ts";
import { syncCliVersion } from "./version-sync.ts";
import { join } from "#models/paths.ts";
import { latestPackageVersion, packageModelsDir, repoRoot, runScript } from "./shared.ts";
import type { JsonValue } from "#models/types.ts";

const OPENCODE_MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_ZEN_DOCS_URL =
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
  freeModelIds: string[];
  endpointByModelId: Map<string, string>;
}

async function syncUserAgent(): Promise<void> {
  const latestVersion = await latestPackageVersion(OPENCODE_NPM_PACKAGE).catch(() => null);
  if (!latestVersion || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    console.warn("Opencode: could not determine latest version from unpkg, skipping.");
    return;
  }
  syncCliVersion("Opencode", OPENCODE_VERSION_TARGETS, latestVersion);
}

function toModelKey(modelId: string): string {
  const cleaned = stripParamInfoKey(modelId);
  if (cleaned.endsWith("-free")) return cleaned.slice(0, -"-free".length);
  return cleaned;
}

function splitMarkdownTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.replace(/`/g, "").trim());
}

function parseMarkdownTables(markdown: string): MarkdownTable[] {
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

    const headers = splitMarkdownTableRow(rows[0] ?? "");
    const body = rows.slice(2).map((row) => splitMarkdownTableRow(row));
    tables.push({ headers, body });
  }

  return tables;
}

function headerIndex(headers: string[], name: string): number {
  return headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());
}

function modelNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

function cell(row: string[], index: number): string {
  return index < 0 ? "" : (row[index] ?? "");
}

function extractFreeModelIdsFromDocs(markdown: string): DocsFreeModels {
  const tables = parseMarkdownTables(markdown);
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
  const endpointModelIdIndex = headerIndex(endpointsTable.headers, "Model ID");
  const endpointUrlIndex = headerIndex(endpointsTable.headers, "Endpoint");
  const pricingModelIndex = headerIndex(pricingTable.headers, "Model");
  const pricingInputIndex = headerIndex(pricingTable.headers, "Input");
  const pricingOutputIndex = headerIndex(pricingTable.headers, "Output");
  const pricingCachedReadIndex = headerIndex(pricingTable.headers, "Cached Read");

  const modelIdsByName = new Map<string, string>();
  const endpointByModelId = new Map<string, string>();

  for (const row of endpointsTable.body) {
    const modelName = cell(row, endpointModelIndex);
    const modelId = cell(row, endpointModelIdIndex);
    const endpoint = cell(row, endpointUrlIndex);
    if (modelName && modelId) modelIdsByName.set(modelNameKey(modelName), modelId);
    if (modelId && endpoint) endpointByModelId.set(modelId, endpoint);
  }

  const modelIds: string[] = [];
  for (const row of pricingTable.body) {
    const isFree = [
      cell(row, pricingInputIndex),
      cell(row, pricingOutputIndex),
      cell(row, pricingCachedReadIndex),
    ].every((value) => value.toLowerCase() === "free");
    if (!isFree) continue;

    const modelName = cell(row, pricingModelIndex);
    const modelId = modelIdsByName.get(modelNameKey(modelName));
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
    freeModelIds: modelIds.sort((a, b) => a.localeCompare(b)),
    endpointByModelId,
  };
}

async function fetchOpencodeFreeModelIds(): Promise<DocsFreeModels> {
  const [docsMarkdown, modelsPayload] = await Promise.all([
    runFetchText(OPENCODE_ZEN_DOCS_URL, { label: "OpenCode Console docs" }),
    runFetchJson(OPENCODE_MODELS_URL, { label: "OpenCode model list" }),
  ]);

  const models = arrayAt(modelsPayload, "data");
  if (models.length === 0) {
    throw new Error("Unexpected Opencode /zen/v1/models payload format");
  }

  const availableModelIds = new Set(
    models.flatMap((model) => {
      const id = asTrimmedString(stringAt(model, "id"));
      return id ? [id] : [];
    })
  );

  const { freeModelIds, endpointByModelId } = extractFreeModelIdsFromDocs(docsMarkdown);
  const missingModelIds = freeModelIds.filter((id) => !availableModelIds.has(id));

  if (missingModelIds.length > 0) {
    console.warn(
      `Opencode: docs list free models missing from /zen/v1/models, skipping: ${missingModelIds.join(", ")}`
    );
  }

  return {
    freeModelIds: freeModelIds.filter((id) => availableModelIds.has(id)),
    endpointByModelId,
  };
}

function buildModelMap(modelIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const modelId of modelIds) {
    const modelKey = toModelKey(modelId);
    if (!map.has(modelKey)) map.set(modelKey, modelId);
  }
  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function buildProviderConfigByModel(
  modelMap: Map<string, string>,
  endpointByModelId: Map<string, string>
): Map<string, Record<string, JsonValue>> {
  const configByModel = new Map<string, Record<string, JsonValue>>();

  for (const [modelKey, modelId] of modelMap.entries()) {
    const endpoint = endpointByModelId.get(modelId) ?? "";
    if (endpoint.includes("/responses")) {
      configByModel.set(modelKey, { responses_api: true });
    } else if (endpoint.includes("/messages")) {
      configByModel.set(modelKey, { messages_api: true });
    }
  }

  return configByModel;
}

async function main(): Promise<void> {
  const modelsDir = packageModelsDir();

  const { freeModelIds, endpointByModelId } = await fetchOpencodeFreeModelIds();
  const modelMap = buildModelMap(freeModelIds);
  const providerConfigByModel = buildProviderConfigByModel(modelMap, endpointByModelId);

  const result = await sync(modelsDir, "opencode", modelMap, {
    providerConfigByModel,
    managedProviderConfigKeys: ["responses_api", "messages_api"],
  });

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Opencode free models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Opencode: ${modelMap.size} free models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }

  await syncUserAgent().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Opencode: User-Agent sync failed (${message})`);
  });
}

runScript(main);
