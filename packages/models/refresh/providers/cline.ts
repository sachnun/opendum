import { Effect, Option, Schema } from "effect";
import { idMap } from "@opendum/models/model-store";
import { fetchJson } from "@opendum/models/sync/http";
import { slashedKey } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";

const MODELS_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const Payload = Schema.Struct({ free: Schema.Array(Schema.Unknown) });
const Entry = Schema.Struct({ id: Schema.String });

const decodePayload = Schema.decodeUnknownOption(Payload);
const decodeEntry = Schema.decodeUnknownOption(Entry);

const freeIds = (payload: unknown): ReadonlyArray<string> => {
  const free = Option.match(decodePayload(payload), {
    onNone: () => [],
    onSome: (value) => value.free,
  });
  if (free.length === 0) throw new Error("unexpected Cline recommended-models payload");

  const ids = free.flatMap((entry) =>
    Option.match(decodeEntry(entry), {
      onNone: () => [],
      onSome: (value) => [value.id],
    })
  );
  if (ids.length === 0) throw new Error("Cline returned no free models");
  return ids;
};

export const clineSource: ModelSource = {
  provider: "cline",
  label: "Cline",
  order: 10,
  phase: "fetch",

  fetch: () =>
    fetchJson(MODELS_URL, { label: "Cline recommended models" }).pipe(
      Effect.map((payload): SourceResult => sourceOf(idMap([...freeIds(payload)], slashedKey))),
      Effect.mapError((cause) => ({ provider: "cline", message: cause.message }))
    ),
};
