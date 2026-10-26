import { Effect } from "effect";
import { fetchText } from "@opendum/models/sync/http";
import { stripParams } from "@opendum/models/model/clean-key";
import { join } from "@opendum/models/paths";
import { sourceOf, type ModelSource, type SourceContext, type SourceResult, type VersionTarget } from "@opendum/models/refresh/core/types";

const PROVIDER = "kiro";
const DOCS_URL = "https://kiro.dev/docs/models/";
const DOWNLOADS_URL = "https://kiro.dev/downloads/";
const PAID_TIERS = ["pro", "pro+", "power", "standalone"];
const LONG_CONTEXT = new Set(["claude-opus-4.6", "claude-sonnet-4.6", "claude-sonnet-4.5"]);

const TABLE = /<table[^>]*>([\s\S]*?)<\/table>/gi;
const ROW = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
const CHUNK = /\/_next\/static\/chunks\/[a-zA-Z0-9._-]+\.js/g;
const BUNDLE_ENTRY = /\{"id":"([a-z0-9.-]+)","name":"([^"]+)","provider":"[^"]+"/g;
const TAG = /<[^>]*>/g;
const VERSION_LABEL = /IDE\s+(\d+\.\d+\.\d+)\s*Latest/;
const VERSION_DOWNLOAD = /kiro-ide-(\d+\.\d+\.\d+)-stable/;
const DATE_SUFFIX = /\.0(?=-|$)/g;

type Row = { name: string; free: boolean; paid: boolean };

const stripHtml = (html: string): string =>
  html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(TAG, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();

const tableRows = (inner: string): ReadonlyArray<ReadonlyArray<string>> => {
  const rows: string[][] = [];
  for (const row of inner.matchAll(ROW)) {
    const cells = [...(row[1] ?? "").matchAll(CELL)].map((cell) => stripHtml(cell[1] ?? ""));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
};

const isIgnored = (name: string): boolean => !/[0-9]/.test(name);

const parseRows = (html: string): ReadonlyArray<Row> => {
  const tables = [...html.matchAll(TABLE)].map((match) => match[1] ?? "");
  if (tables.length === 0) throw new Error("no tables found on the Kiro docs page");

  for (const table of tables) {
    const rows = tableRows(table);
    if (rows.length === 0) continue;

    const header = (rows[0] ?? []).map((cell) => cell.toLowerCase());
    const hasModel = header.some((cell) => cell.includes("model"));
    const hasContext = header.some((cell) => cell.includes("context"));
    if (!hasModel || !hasContext) continue;

    const nameIndex = header.findIndex((cell) => cell.includes("model"));
    const freeIndex = header.findIndex((cell) => cell === "free");
    const proIndex = header.findIndex((cell) => cell === "pro");
    const proPlusIndex = header.findIndex(
      (cell) => cell === "pro+" || cell === "pro plus" || (cell.startsWith("pro") && cell.includes("+"))
    );
    const powerIndex = header.findIndex((cell) => cell === "power");
    if (nameIndex < 0) throw new Error("could not find the Model column in the Kiro comparison table");

    const parsed: Row[] = [];
    for (const row of rows.slice(1)) {
      const name = (row[nameIndex] ?? "").trim();
      if (!name) continue;
      const free = (freeIndex >= 0 ? (row[freeIndex] ?? "") : "").length > 0;
      const paid =
        (proIndex >= 0 ? (row[proIndex] ?? "") : "").length > 0 ||
        (proPlusIndex >= 0 ? (row[proPlusIndex] ?? "") : "").length > 0 ||
        (powerIndex >= 0 ? (row[powerIndex] ?? "") : "").length > 0;
      parsed.push({ name, free, paid });
    }
    if (parsed.length === 0) throw new Error("no models found in the Kiro comparison table");
    return parsed;
  }
  throw new Error('could not find the Kiro "Quick comparison" table');
};

const publishedIds = (html: string): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.gen(function* () {
    const chunks = [...new Set([...html.matchAll(CHUNK)].map((match) => match[0]))];
    const byName = new Map<string, string>();

    for (const chunk of chunks) {
      const script = yield* fetchText(new URL(chunk, DOCS_URL).toString(), {
        label: `Kiro bundle ${chunk}`,
      }).pipe(Effect.catchCause(() => Effect.succeed("")));
      for (const match of script.matchAll(BUNDLE_ENTRY)) {
        const name = match[2];
        const id = match[1];
        if (name && id && !byName.has(name)) byName.set(name, id);
      }
    }
    return byName;
  });

const modelId = (displayName: string, catalog: ReadonlyMap<string, string>): string => {
  const published = catalog.get(displayName);
  if (published) return published;
  return displayName
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(DATE_SUFFIX, "")
    .replace(/^minimax-(\d)/, "minimax-m$1");
};

const variants = (id: string): ReadonlyArray<string> =>
  LONG_CONTEXT.has(id) ? [id, `${id}-1m`] : [id];

const canonical = (id: string): { key: string; upstream: string } => {
  let key = id;
  if (key.startsWith("claude-")) key = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  if (key.startsWith("deepseek-") && /^deepseek-\d/.test(key)) key = key.replace(/^deepseek-/, "deepseek-v");
  return { key: stripParams(key).replace(/[^a-z0-9.-]/g, ""), upstream: id };
};

const versionTargets = (ctx: SourceContext): ReadonlyArray<VersionTarget> => [
  {
    label: "kiro provider",
    path: join(ctx.repoRoot, "packages/providers/upstreams/kiro/index.ts"),
    pattern: /(KiroIDE-)(\d+\.\d+\.\d+)(")/,
  },
  {
    label: "kiro quota fetcher",
    path: join(ctx.repoRoot, "packages/providers/quota/fetchers/kiro.ts"),
    pattern: /(KiroIDE-)(\d+\.\d+\.\d+)(")/,
  },
];

const latestVersion = (): Effect.Effect<string | null> =>
  fetchText(DOWNLOADS_URL, { label: "Kiro downloads page", headers: { Accept: "text/html" } }).pipe(
    Effect.map((html) => VERSION_LABEL.exec(html)?.[1] ?? VERSION_DOWNLOAD.exec(html)?.[1] ?? null),
    Effect.catchCause((cause) =>
      Effect.andThen(
        Effect.logWarning(`[Kiro] could not read the IDE version (${String(cause)})`),
        Effect.succeed(null)
      )
    )
  );

export const kiroSource: ModelSource = {
  provider: PROVIDER,
  label: "Kiro",
  order: 55,
  phase: "fetch",

  fetch: () =>
    Effect.gen(function* () {
      const html = yield* fetchText(DOCS_URL, {
        label: "Kiro docs",
        headers: { Accept: "text/html" },
      });
      const rows = parseRows(html);
      const catalog = yield* publishedIds(html);

      const usable = rows.filter((row) => !isIgnored(row.name));
      if (usable.length === 0) throw new Error("Kiro docs returned no usable models");

      const models = new Map<string, string>();
      for (const row of usable) {
        for (const id of variants(modelId(row.name, catalog))) {
          const entry = canonical(id);
          models.set(entry.key, entry.upstream);
        }
      }

      const paid = new Map<string, Record<string, unknown>>();
      for (const row of usable) {
        if (row.free || !row.paid) continue;
        for (const id of variants(modelId(row.name, catalog))) {
          paid.set(canonical(id).key, { allowedTiers: PAID_TIERS });
        }
      }

      return {
        ...sourceOf(models),
        providerConfig: paid,
        managedKeys: ["allowedTiers"],
      } satisfies SourceResult;
    }).pipe(Effect.mapError((cause) => ({ provider: PROVIDER, message: cause.message }))),

  versionTargets,
  latestVersion,
};
