import { Effect, Cause } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { buildIndex } from "@opendum/models/model-store";
import { fetchText } from "@opendum/models/sync/http";
import { normalizeKey, normalizeName } from "@opendum/models/model/similarity";
import { join } from "@opendum/models/paths";
import { packageVersion } from "@opendum/models/refresh/core/fetch";
import { causeMessage } from "@opendum/models/refresh/core/failure";
import type { ModelFetchFailure, ModelTimeoutFailure } from "@opendum/models/errors";
import type { ModelIndexEntry } from "@opendum/models/types";
import { sourceOf, type ModelSource, type SourceContext, type SourceResult, type VersionTarget } from "@opendum/models/refresh/core/types";
import { compareText } from "@opendum/models/compare";

const PROVIDER = "perch";
const DOCS_URL = "https://www.perchai.app/docs/concepts/models";
const CLI_PACKAGE = "perchai-cli";

const TABLE = /<table[^>]*>([\s\S]*?)<\/table>/g;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL = /<td[^>]*>([\s\S]*?)<\/td>/g;
const COMMAND = /\/model\s+(\S+)/i;
const TAG = /<[^>]+>/g;
const TRAILING_DATE = /[\s_-]+\d{4,8}$/;

type Row = { name: string; command: string };
type Lookup = ReadonlyMap<string, ModelIndexEntry | null>;

const decodeHtml = (text: string): string =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

const stripHtml = (text: string): string =>
  decodeHtml(text.replace(TAG, " ")).replace(/\s+/g, " ").trim();

const compactName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const stripDate = (value: string): string => value.replace(TRAILING_DATE, "").trim();

const extractRows = (html: string): ReadonlyArray<Row> => {
  for (const table of html.matchAll(TABLE)) {
    const body = table[1] ?? "";
    const headerEnd = body.indexOf("</thead>");
    const header = headerEnd === -1 ? body : body.slice(0, headerEnd);
    if (!/Desktop and CLI command/i.test(header)) continue;

    const bodyStart = body.indexOf("<tbody");
    const bodyEnd = body.indexOf("</tbody>", bodyStart);
    const section = bodyStart === -1 ? body : body.slice(bodyStart, bodyEnd);

    const rows: Row[] = [];
    for (const row of section.matchAll(ROW)) {
      const cells = [...(row[1] ?? "").matchAll(CELL)].map((cell) => stripHtml(cell[1] ?? ""));
      if (cells.length < 3) continue;
      const name = cells[0];
      const command = COMMAND.exec(cells[2] ?? "")?.[1];
      if (!name || !command) continue;
      rows.push({ name, command });
    }
    if (rows.length > 0) return rows;
  }
  raise(new Error("unable to locate the Perch Starter model table in the docs page"));
};

const perchUpstream = (entry: ModelIndexEntry): string | null => {
  const value = entry.data.providerConfig?.[PROVIDER]?.upstream;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const register = (map: Map<string, ModelIndexEntry | null>, key: string, entry: ModelIndexEntry): void => {
  if (!key) return;
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, entry);
    return;
  }
  if (existing !== entry) map.set(key, null);
};

const buildLookup = (modelsDir: string): { byCompact: Lookup; byNormalized: Lookup } => {
  const byCompact = new Map<string, ModelIndexEntry | null>();
  const byNormalized = new Map<string, ModelIndexEntry | null>();

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
};

const resolve = (lookups: { byCompact: Lookup; byNormalized: Lookup }, row: Row): ModelIndexEntry | null => {
  const { byCompact, byNormalized } = lookups;
  for (const candidate of [row.command, row.name, stripDate(row.name)]) {
    const entry =
      byCompact.get(compactName(candidate)) ??
      byNormalized.get(normalizeName(candidate)) ??
      byNormalized.get(normalizeKey(candidate)) ??
      null;
    if (entry) return entry;
  }
  return null;
};

const starterPool = (
  modelsDir: string,
  rows: ReadonlyArray<Row>
): { models: Map<string, string>; unresolved: ReadonlyArray<string> } => {
  const lookups = buildLookup(modelsDir);
  const models = new Map<string, string>();
  const unresolved: string[] = [];

  for (const row of rows) {
    const entry = resolve(lookups, row);
    if (!entry) {
      unresolved.push(row.name);
      continue;
    }
    const existing = models.get(entry.fileId);
    if (existing !== undefined && existing !== row.command) {
      raise(new Error(`duplicate Perch Starter mapping for ${entry.fileId}`));
    }
    models.set(entry.fileId, row.command);
  }

  return {
    models: new Map([...models.entries()].sort(([left], [right]) => compareText(left, right))),
    unresolved,
  };
};

const registeredPool = (modelsDir: string): Map<string, string> =>
  new Map(
    Object.values(buildIndex(modelsDir))
      .flatMap((entry) => {
        if (!(entry.data.providers ?? []).includes(PROVIDER)) return [];
        const upstream = perchUpstream(entry);
        return upstream ? [[entry.fileId, upstream] as const] : [];
      })
      .sort(([left], [right]) => compareText(left, right))
  );

const degraded = (
  ctx: SourceContext,
  cause: ModelFetchFailure | ModelTimeoutFailure
): Effect.Effect<SourceResult> =>
  Effect.andThen(
    Effect.logWarning(
      `[Perch] docs unavailable (${causeMessage(Cause.fail(cause))}); keeping the ${registeredPool(ctx.modelsDir).size} registered Starter model(s)`
    ),
    Effect.sync(() => sourceOf(registeredPool(ctx.modelsDir)) as SourceResult)
  );

const versionTargets = (ctx: SourceContext): ReadonlyArray<VersionTarget> => [
  {
    label: "perch provider",
    path: join(ctx.repoRoot, "packages/providers/upstreams/perch/auth.ts"),
    pattern: /(const CLI_VERSION = ")(\d+\.\d+\.\d+)(")/,
  },
];

export const perchSource: ModelSource = {
  provider: PROVIDER,
  label: "Perch",
  order: 45,
  phase: "fetch",

  fetch: (ctx) =>
    fetchText(DOCS_URL, {
      label: "Perch models docs",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; opendum-model-sync)" },
    }).pipe(
      Effect.map((html): SourceResult => {
        const rows = extractRows(html);
        if (rows.length === 0) raise(new Error("Perch Starter model table is empty"));
        const { models, unresolved } = starterPool(ctx.modelsDir, rows);
        if (unresolved.length > 0) {
          console.warn(`[Perch] skipped Starter model(s) absent from the registry: ${unresolved.join(", ")}`);
        }
        return sourceOf(models);
      }),
      Effect.catchTags({
        ModelFetchFailure: (cause) => degraded(ctx, cause),
        ModelTimeoutFailure: (cause) => degraded(ctx, cause),
      }),
      Effect.mapError((cause: unknown) => ({
        provider: PROVIDER,
        message: cause instanceof Error ? cause.message : String(cause),
      }))
    ),

  versionTargets,

  latestVersion: () =>
    packageVersion(CLI_PACKAGE).pipe(
      Effect.map((version) => (/^\d+\.\d+\.\d+$/.test(version) ? version : null)),
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.logWarning(`[Perch] could not determine the latest CLI version (${String(cause)})`),
          Effect.succeed(null)
        )
      )
    ),
};
