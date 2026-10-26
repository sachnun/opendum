import { Effect, Option, Schema } from "effect";
import { fetchText } from "@opendum/models/sync/http";
import { stripParams } from "@opendum/models/model/clean-key";
import { packageVersion } from "@opendum/models/refresh/core/fetch";
import { join } from "@opendum/models/paths";
import { sourceOf, type ModelSource, type SourceContext, type SourceResult, type VersionTarget } from "@opendum/models/refresh/core/types";

const PROVIDER = "opencode";
const DOCS_URL =
  "https://raw.githubusercontent.com/anomalyco/opencode/dev/services/www/src/docs/content/console/models.mdx";
const MODELS_URL = "https://opencode.ai/zen/v1/models";
const NPM_PACKAGE = "opencode-ai";

const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*\|/;
const PIPE_EDGE = /^\||\|$/g;
const BACKTICK = /`/g;
const PAYLOAD = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodePayload = Schema.decodeUnknownOption(PAYLOAD);

type Table = { headers: ReadonlyArray<string>; body: ReadonlyArray<ReadonlyArray<string>> };

const toKey = (modelId: string): string => {
  const cleaned = stripParams(modelId);
  return cleaned.endsWith("-free") ? cleaned.slice(0, -"-free".length) : cleaned;
};

const splitRow = (row: string): ReadonlyArray<string> =>
  row.trim().replace(PIPE_EDGE, "").split("|").map((cell) => cell.replace(BACKTICK, "").trim());

const parseTables = (markdown: string): ReadonlyArray<Table> => {
  const tables: Table[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? "";
    const separator = lines[index + 1] ?? "";
    if (!line.trim().startsWith("|") || !SEPARATOR.test(separator)) continue;

    const rows: string[] = [];
    let cursor = index;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().startsWith("|")) {
      rows.push(lines[cursor] ?? "");
      cursor += 1;
    }
    index = cursor - 1;

    tables.push({
      headers: splitRow(rows[0] ?? ""),
      body: rows.slice(2).map(splitRow),
    });
  }
  return tables;
};

const headerIndex = (headers: ReadonlyArray<string>, name: string): number =>
  headers.findIndex((header) => header.toLowerCase() === name.toLowerCase());

const nameKey = (value: string): string => value.replace(/\s+/g, " ").trim().toLowerCase();

const cell = (row: ReadonlyArray<string>, index: number): string =>
  index < 0 ? "" : (row[index] ?? "");

const extractFree = (markdown: string): { freeModels: ReadonlyArray<string>; endpoints: ReadonlyMap<string, string> } => {
  const tables = parseTables(markdown);
  const endpointsTable = tables.find(
    (table) => headerIndex(table.headers, "Model ID") !== -1 && headerIndex(table.headers, "Endpoint") !== -1
  );
  const pricingTable = tables.find(
    (table) =>
      headerIndex(table.headers, "Input") !== -1 &&
      headerIndex(table.headers, "Output") !== -1 &&
      headerIndex(table.headers, "Cached Read") !== -1
  );
  if (!endpointsTable || !pricingTable) {
    throw new Error("unexpected OpenCode Console docs format: endpoint or pricing table missing");
  }

  const idsByName = new Map<string, string>();
  const endpoints = new Map<string, string>();

  for (const row of endpointsTable.body) {
    const name = cell(row, headerIndex(endpointsTable.headers, "Model"));
    const id = cell(row, headerIndex(endpointsTable.headers, "Model ID"));
    const endpoint = cell(row, headerIndex(endpointsTable.headers, "Endpoint"));
    if (name && id) idsByName.set(nameKey(name), id);
    if (id && endpoint) endpoints.set(id, endpoint);
  }

  const pricingModel = headerIndex(pricingTable.headers, "Model");
  const pricingInput = headerIndex(pricingTable.headers, "Input");
  const pricingOutput = headerIndex(pricingTable.headers, "Output");
  const pricingCached = headerIndex(pricingTable.headers, "Cached Read");

  const freeModels: string[] = [];
  for (const row of pricingTable.body) {
    const free = [cell(row, pricingInput), cell(row, pricingOutput), cell(row, pricingCached)].every(
      (value) => value.toLowerCase() === "free"
    );
    if (!free) continue;
    const id = idsByName.get(nameKey(cell(row, pricingModel)));
    if (!id) throw new Error("OpenCode pricing model missing from the endpoint table");
    freeModels.push(id);
  }
  if (freeModels.length === 0) throw new Error("OpenCode docs listed no free models");

  return { freeModels: freeModels.sort((left, right) => left.localeCompare(right)), endpoints };
};

const availableIds = (payload: unknown): ReadonlySet<string> =>
  new Set(
    Option.getOrElse(
      Option.map(decodePayload(payload), (value) => value.data.map((entry) => entry.id)),
      () => [] as ReadonlyArray<string>
    )
  );

const configOf = (
  models: ReadonlyMap<string, string>,
  endpoints: ReadonlyMap<string, string>
): ReadonlyMap<string, Record<string, unknown>> => {
  const config = new Map<string, Record<string, unknown>>();
  for (const [key, id] of models) {
    const endpoint = endpoints.get(id) ?? "";
    if (endpoint.includes("/responses")) config.set(key, { responses_api: true });
    else if (endpoint.includes("/messages")) config.set(key, { messages_api: true });
  }
  return config;
};

const versionTargets = (ctx: SourceContext): ReadonlyArray<VersionTarget> => [
  {
    label: "opencode provider",
    path: join(ctx.repoRoot, "packages/providers/upstreams/opencode.ts"),
    pattern: /(const USER_AGENT = "opencode\/)(\d+\.\d+\.\d+)(")/,
  },
  {
    label: "opencode provider test",
    path: join(ctx.repoRoot, "packages/providers/upstreams/opencode.test.ts"),
    pattern: /(toBe\("opencode\/)(\d+\.\d+\.\d+)(")/,
  },
  {
    label: "codex provider",
    path: join(ctx.repoRoot, "packages/providers/upstreams/codex.ts"),
    pattern: /(User-Agent": `opencode\/)(\d+\.\d+\.\d+)( \()/,
  },
  {
    label: "codex quota fetcher",
    path: join(ctx.repoRoot, "packages/providers/quota/fetchers/codex.ts"),
    pattern: /(User-Agent": `opencode\/)(\d+\.\d+\.\d+)( \()/,
  },
  {
    label: "codex web constants",
    path: join(ctx.repoRoot, "apps/api/web/lib/providers/codex/constants.ts"),
    pattern: /(const OPENCODE_VERSION = ")(\d+\.\d+\.\d+)(")/,
  },
];

const latestVersion = (): Effect.Effect<string | null> =>
  packageVersion(NPM_PACKAGE).pipe(
    Effect.map((version) => (/^\d+\.\d+\.\d+$/.test(version) ? version : null)),
    Effect.catchCause((cause) =>
      Effect.andThen(
        Effect.logWarning(`[Opencode] could not read the latest version (${String(cause)})`),
        Effect.succeed(null)
      )
    )
  );

export const opencodeSource: ModelSource = {
  provider: PROVIDER,
  label: "Opencode",
  order: 60,
  phase: "fetch",

  fetch: () =>
    Effect.gen(function* () {
      const markdown = yield* fetchText(DOCS_URL, { label: "OpenCode Console docs" });
      const payload = yield* fetchText(MODELS_URL, { label: "OpenCode model list" }).pipe(
        Effect.flatMap((text) =>
          Effect.try(() => JSON.parse(text) as unknown).pipe(Effect.orElseSucceed(() => ({})))
        )
      );
      const available = availableIds(payload);
      if (available.size === 0) throw new Error("unexpected Opencode /zen/v1/models payload");

      const { freeModels, endpoints } = extractFree(markdown);
      const missing = freeModels.filter((id) => !available.has(id));
      if (missing.length > 0) {
        yield* Effect.logWarning(
          `[Opencode] docs list free models missing from /zen/v1/models: ${missing.join(", ")}`
        );
      }

      const models = new Map<string, string>();
      for (const id of freeModels.filter((entry) => available.has(entry))) {
        const key = toKey(id);
        if (!models.has(key)) models.set(key, id);
      }
      if (models.size === 0) throw new Error("Opencode resolved no free models");

      return {
        ...sourceOf(new Map([...models.entries()].sort(([left], [right]) => left.localeCompare(right)))),
        providerConfig: configOf(models, endpoints),
        managedKeys: ["responses_api", "messages_api"],
      } satisfies SourceResult;
    }).pipe(Effect.mapError((cause) => ({ provider: PROVIDER, message: cause.message }))),

  versionTargets,
  latestVersion,
};
