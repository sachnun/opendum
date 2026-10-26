import { Chunk, Effect, Option, Schema } from "effect";
import { parseJson as parseJsonPayload } from "@opendum/models/refresh/core/json";
import { idMap } from "@opendum/models/model-store";
import { fetchText } from "@opendum/models/sync/http";
import { standardKey } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";

const MODELS_URL = "https://tokenharbor.ai/models";

const Entry = Schema.Struct({
  surface: Schema.String,
  free: Schema.Boolean,
  modalities: Schema.NullOr(Schema.String),
});

type Entry = typeof Entry.Type;

const DETAILED =
  /"surface":"([^"]+)".*?"isFree":(true|false),.*?"inputModalities":(\[[^\]]*\]),"outputModalities":(\[[^\]]*\])/g;
const SURFACE = /"surface":"([^"]+)"/g;

const decodeEntry = Schema.decodeUnknownOption(Entry);
const decodeModalities = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));

const unescape = (html: string): string => html.replace(/\\"/g, '"');

const detailed = (html: string): Chunk.Chunk<Entry> =>
  Chunk.fromIterable([...unescape(html).matchAll(DETAILED)]).pipe(
    Chunk.flatMap((match) =>
      Option.match(Option.all({ surface: Option.fromNullishOr(match[1]), free: Option.fromNullishOr(match[2]) }), {
        onNone: () => Chunk.empty<Entry>(),
        onSome: ({ surface, free }) =>
          Chunk.fromIterable(
            Option.match(decodeEntry({ surface, free: free === "true", modalities: match[3] ?? null }), {
              onNone: () => [] as Entry[],
              onSome: (entry) => [entry],
            })
          ),
      })
    )
  );

const fallback = (html: string): Chunk.Chunk<Entry> =>
  Chunk.fromIterable([...unescape(html).matchAll(SURFACE)]).pipe(
    Chunk.flatMap((match) =>
      Option.match(Option.fromNullishOr(match[1]), {
        onNone: () => Chunk.empty<Entry>(),
        onSome: (surface) =>
          surface.endsWith(":free")
            ? Chunk.of<Entry>({ surface, free: true, modalities: null })
            : Chunk.empty<Entry>(),
      })
    )
  );

const textCapable = (entry: Entry): boolean =>
  Option.match(Option.fromNullishOr(entry.modalities), {
    onNone: () => true,
    onSome: (raw) =>
      Option.match(decodeModalities(parseJsonPayload(raw)), {
        onNone: () => true,
        onSome: (values) => values.length === 0 || values.includes("text"),
      }),
  });

const firstBySurface = (entries: Chunk.Chunk<Entry>): ReadonlyMap<string, Entry> => {
  const map = new Map<string, Entry>();
  for (const entry of Chunk.toReadonlyArray(entries)) {
    if (!map.has(entry.surface)) map.set(entry.surface, entry);
  }
  return map;
};

function freeIds(html: string): ReadonlyArray<string> {
  const entries = Chunk.appendAll(detailed(html))(fallback(html));
  const bySurface = firstBySurface(entries);

  if (bySurface.size === 0) return [];

  return Chunk.toReadonlyArray(Chunk.dedupe(Chunk.map(entries, (entry) => entry.surface)))
    .flatMap((surface) => {
      const entry = bySurface.get(surface);
      if (!entry) return [];
      const free = entry.free || entry.surface.endsWith(":free");
      return free && textCapable(entry) ? [entry.surface.trim()] : [];
    })
    .filter((id) => id.length > 0)
    .sort((left, right) => left.localeCompare(right));
}

export const harborSource: ModelSource = {
  provider: "harbor",
  label: "Harbor",
  order: 30,
  phase: "fetch",

  fetch: () =>
    fetchText(MODELS_URL, { label: "Harbor /models catalog page" }).pipe(
      Effect.map((html): SourceResult => sourceOf(idMap([...freeIds(html)], standardKey))),
      Effect.mapError((cause) => ({ provider: "harbor", message: cause.message }))
    ),
};
