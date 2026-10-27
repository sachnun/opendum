import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { parseJson } from "@opendum/models/refresh/core/json";
import { buildIndex } from "@opendum/models/model-store";
import { fetchText } from "@opendum/models/sync/http";
import { entryFor, writeEntry } from "@opendum/models/refresh/core/keys";
import { join } from "@opendum/models/paths";
import {
  sourceOf,
  type ModelSource,
  type SourceContext,
  type SourceResult,
  type VersionTarget,
} from "@opendum/models/refresh/core/types";
import { compareText } from "@opendum/models/compare";

const PROVIDER = "antigravity";
const DOCS_URL = "https://antigravity.google/docs/models";
const CHANGELOG_URL = "https://antigravity.google/docs/changelog.md";
const CHANGELOG_TAB = "hub";
const PAID_TIERS = ["g1-pro-tier", "g1-ultra-tier", "standard-tier", "paid"];
const FLASH_LEVELS = ["low", "medium", "high"];

const EFFORT_SUFFIX = new Map([
  ["claude-opus-4-6", "thinking"],
  ["claude-sonnet-4-6", ""],
  ["claude-opus-5-5", "medium"],
  ["claude-sonnet-5-5", "medium"],
  ["gpt-oss-120b", "medium"],
]);

const FLASH = /^gemini-3\.(\d+)-flash$/;
const LEVELED = /^gemini-\d+-[a-z]+$/;
const PRO = /^gemini-\d+(?:\.\d+)*-pro$/;
const RELEASE = /^###\s+\[v?(\d+\.\d+\.\d+)\]\(([^)]*)\)/gm;

const Widget = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  tiers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  levels: Schema.optional(Schema.Array(Schema.String)),
});

type Widget = typeof Widget.Type;
type Meta = { reasoning: boolean; modalities: { input: string[]; output: string[] } };

const decodeWidget = Schema.decodeUnknownOption(Widget);

const decodeHtml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const parseWidgets = (html: string): ReadonlyArray<Widget> => {
  const start = html.indexOf("model-selector-group");
  if (start < 0) raise(new Error("could not find the Antigravity model selector in the docs"));

  const seen = new Map<string, Widget>();
  for (const row of html.slice(start).split(/<div class="model-item-row/).slice(1)) {
    const id = /data-model-id="([^"]+)"/.exec(row)?.[1];
    if (!id || seen.has(id)) continue;

    const name = decodeHtml(/<span class="model-name">([^<]*)<\/span>/.exec(row)?.[1] ?? "").trim();
    const tiersRaw = decodeHtml(/data-tiers="([^"]*)"/.exec(row)?.[1] ?? "");
    const tiers = Option.getOrElse(
      Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))(
        parseJson(tiersRaw || "{}")
      ),
      () => ({})
    );
    const levels = [...row.matchAll(/data-level-btn="([^"]+)"/g)].map((match) => match[1]?.trim() ?? "");

    Option.match(decodeWidget({ id, name, tiers, levels }), {
      onNone: () => undefined,
      onSome: (widget) => seen.set(id, widget),
    });
    if (seen.size >= 50) break;
  }

  if (seen.size === 0) raise(new Error("no Antigravity models found in the docs model selector"));
  return [...seen.values()];
};

const leveledKey = (key: string): string => {
  const flash = FLASH.exec(key);
  if (flash) return Number(flash[1]) >= 5 ? key : "";
  return LEVELED.test(key) ? key : "";
};

const leveledUpstream = (key: string): string => {
  if (!leveledKey(key)) return "";
  const flash = FLASH.exec(key);
  if (flash) return Number(flash[1]) >= 7 ? `${key}-tiered` : `${key}-medium`;
  return `${key}-medium`;
};

const leveledAliases = (key: string): ReadonlyArray<string> =>
  leveledKey(key) ? FLASH_LEVELS.map((level) => `${key}-${level}`) : [];

const keyOf = (id: string): string => (id.startsWith("claude-") ? id.replace(/\.(?=\d)/g, "-") : id);

const upstreamOf = (widget: Widget): string => {
  const key = keyOf(widget.id);
  if (leveledKey(key)) return leveledUpstream(key);
  if (PRO.test(widget.id)) return widget.id;
  const suffix = EFFORT_SUFFIX.get(key) ?? "";
  return suffix ? `${key}-${suffix}` : key;
};

const rank = (value: string): number => {
  if (value.endsWith("-high")) return 3;
  if (value.endsWith("-medium")) return 2;
  if (value.endsWith("-low")) return 1;
  return 0;
};

const buildModels = (widgets: ReadonlyArray<Widget>): Map<string, string> => {
  const models = new Map<string, string>();
  const ranks = new Map<string, number>();
  for (const widget of widgets) {
    const key = keyOf(widget.id);
    const value = upstreamOf(widget);
    const next = rank(value);
    if (!models.has(key) || next > (ranks.get(key) ?? 0)) {
      models.set(key, value);
      ranks.set(key, next);
    }
  }
  if (models.size === 0) raise(new Error("no Antigravity model IDs could be derived from the docs"));
  return models;
};

const paidConfig = (
  models: ReadonlyMap<string, string>,
  widgets: ReadonlyArray<Widget>
): ReadonlyMap<string, Record<string, unknown>> => {
  const free = new Map<string, boolean>();
  for (const widget of widgets) {
    const key = keyOf(widget.id);
    if (widget.tiers?.freeAndPlus === true) free.set(key, true);
    else if (!free.has(key)) free.set(key, false);
  }

  const config = new Map<string, Record<string, unknown>>();
  for (const key of models.keys()) {
    if (free.get(key) === true) continue;
    config.set(key, { allowedTiers: PAID_TIERS });
  }
  return config;
};

const existingUpstream = (entry: { data: { providerConfig?: Record<string, { upstream?: unknown }> } }): string => {
  const value = entry.data.providerConfig?.[PROVIDER]?.upstream;
  return typeof value === "string" && value.trim() ? value.trim() : "";
};

const mergeExtras = (ctx: SourceContext, models: Map<string, string>): ReadonlyArray<string> => {
  const extras: string[] = [];
  const index = buildIndex(ctx.modelsDir);

  for (const entry of Object.values(index)) {
    if (!(entry.data.providers ?? []).includes(PROVIDER)) continue;
    const key = entry.fileId;
    if (models.has(key)) continue;
    const value = existingUpstream(entry) || key;
    models.set(key, value);
    extras.push(key);
  }

  for (const entry of Object.values(index)) {
    const id = entry.id;
    if (!id || id === entry.fileId || models.has(id)) continue;
    if (!(entry.data.providers ?? []).includes(PROVIDER)) continue;
    models.set(id, existingUpstream(entry) || id);
    extras.push(id);
  }

  return extras;
};

const inferMeta = (key: string): Meta | null => {
  if (key.startsWith("gemini-")) {
    const image = key.includes("image");
    return {
      reasoning: !image,
      modalities: { input: ["text", "image"], output: image ? ["image"] : ["text"] },
    };
  }
  if (key.startsWith("claude-")) return { reasoning: true, modalities: { input: ["text", "image"], output: ["text"] } };
  if (key.startsWith("gpt-oss-")) return { reasoning: true, modalities: { input: ["text"], output: ["text"] } };
  return null;
};

const latestRelease = (text: string): string | null => {
  const versions: string[] = [];
  for (const match of text.matchAll(RELEASE)) {
    if (!(match[2] ?? "").includes(`tab=${CHANGELOG_TAB}`)) continue;
    versions.push(match[1] ?? "");
  }
  if (versions.length === 0) return null;
  return versions
    .filter(Boolean)
    .sort((left, right) => {
      const [aMajor = 0, aMinor = 0, aPatch = 0] = left.split(".").map(Number);
      const [bMajor = 0, bMinor = 0, bPatch = 0] = right.split(".").map(Number);
      return aMajor - bMajor || aMinor - bMinor || aPatch - bPatch;
    })
    .at(-1) ?? null;
};

const versionTargets = (ctx: SourceContext): ReadonlyArray<VersionTarget> => [
  {
    label: "antigravity provider",
    path: join(ctx.repoRoot, "packages/providers/upstreams/antigravity/index.ts"),
    pattern: /(antigravity\/)(\d+\.\d+\.\d+)( \$\{process\.platform\})/,
  },
  {
    label: "antigravity quota fetcher",
    path: join(ctx.repoRoot, "packages/providers/quota/fetchers/antigravity.ts"),
    pattern: /(antigravity\/)(\d+\.\d+\.\d+)( \$\{process\.platform\})/,
  },
];

const latestVersion = (): Effect.Effect<string | null> =>
  fetchText(CHANGELOG_URL, { label: "Antigravity changelog", headers: { Accept: "text/markdown" } }).pipe(
    Effect.map(latestRelease),
    Effect.catchCause((cause) =>
      Effect.andThen(
        Effect.logWarning(`[Antigravity] could not read the changelog (${String(cause)})`),
        Effect.succeed(null)
      )
    )
  );

export const antigravitySource: ModelSource = {
  provider: PROVIDER,
  label: "Antigravity",
  order: 5,
  phase: "fetch",

  fetch: (ctx) =>
    fetchText(DOCS_URL, { label: "Antigravity model docs" }).pipe(
      Effect.map((html): SourceResult => {
        const widgets = parseWidgets(html);
        const models = buildModels(widgets);
        const extras = mergeExtras(ctx, models);
        if (extras.length > 0) {
          console.log(`[Antigravity] preserved ${extras.length} JSON-configured extras`);
        }
        const aliases = new Map(
          widgets.map((widget) => [keyOf(widget.id), leveledAliases(keyOf(widget.id))])
        );
        return {
          ...sourceOf(new Map([...models.entries()].sort(([left], [right]) => compareText(left, right)))),
          providerConfig: paidConfig(models, widgets),
          managedKeys: ["allowedTiers"],
          extra: new Map([["aliases", aliases]]),
        };
      }),
      Effect.mapError((cause) => ({ provider: PROVIDER, message: cause.message }))
    ),

  enrich: (ctx, result, outcome) =>
    Effect.gen(function* () {
      const aliases = Option.match(Option.fromNullishOr(result.extra?.get("aliases")), {
        onNone: () => new Map<string, ReadonlyArray<string>>(),
        onSome: (value) => value as Map<string, ReadonlyArray<string>>,
      });
      const changed = new Set([...outcome.added, ...outcome.updated]);
      if (changed.size === 0) return [] as ReadonlyArray<string>;

      let touched = 0;
      for (const key of changed) {
        const found = entryFor(ctx.modelsDir, key);
        if (found._tag === "None") continue;
        const data = found.value.data;
        let dirty = false;

        if (data.ignored === true && result.models.has(key)) {
          delete data.ignored;
          dirty = true;
        }

        const meta = inferMeta(key);
        if (meta) {
          if (data.reasoning === undefined) {
            data.reasoning = meta.reasoning;
            dirty = true;
          }
          if (data.modalities === undefined) {
            data.modalities = meta.modalities;
            dirty = true;
          }
        }

        const desired = aliases.get(key) ?? leveledAliases(key);
        if (desired.length > 0) {
          const merged = new Set([...(data.aliases ?? []), ...desired]);
          const next = [...merged].sort();
          if (JSON.stringify(data.aliases ?? []) !== JSON.stringify(next)) {
            data.aliases = next;
            dirty = true;
          }
        }

        if (!dirty) continue;
        yield* writeEntry(found.value, data);
        touched += 1;
      }

      return touched > 0 ? [`[Antigravity] refreshed metadata for ${touched} model(s)`] : [];
    }),

  versionTargets,
  latestVersion,
};
