import { Effect, Option, Schema } from "effect";
import { raise } from "@opendum/models/refresh/sources/raise";
import { idMap } from "@opendum/models/model-store";
import { fetchDecoded } from "@opendum/models/sync/http";
import { afterFirstSlash, standardKey } from "@opendum/models/refresh/sources/keys";
import type { ModelSource, SourceResult } from "@opendum/models/refresh/sources/types";

const MODELS_URL = "https://api.kilo.ai/api/gateway/models";
const AUTO_PREFIX = "kilo-auto/";
const TRAILING_PARAMS = /(?::[a-zA-Z0-9_-]+)+$/;

const Entry = Schema.Struct({
  id: Schema.String,
  isFree: Schema.optional(Schema.Boolean),
});
const Payload = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const decodePayload = Schema.decodeUnknownOption(Payload);
const decodeEntry = Schema.decodeUnknownOption(Entry);

const keyOf = (modelId: string): string =>
  modelId.startsWith(AUTO_PREFIX)
    ? standardKey(modelId.replace("/", "-"))
    : standardKey(afterFirstSlash(modelId).replace(TRAILING_PARAMS, ""));

const freeIds = (payload: unknown): ReadonlyArray<string> => {
  const entries = Option.match(decodePayload(payload), {
    onNone: () => [] as ReadonlyArray<unknown>,
    onSome: (value) => value.data,
  });
  if (entries.length === 0) raise(new Error("unexpected Kilo Gateway /models payload"));

  return entries.flatMap((entry) =>
    Option.match(decodeEntry(entry), {
      onNone: () => [],
      onSome: (value) => (value.isFree === true ? [value.id] : []),
    })
  );
};

export const kilocodeSource: ModelSource = {
  provider: "kilo_code",
  label: "Kilo Code",
  order: 50,
  phase: "fetch",

  fetch: () =>
    fetchDecoded(
      MODELS_URL,
      { label: "Kilo Code models", headers: { Accept: "application/json" } },
      async (response) => freeIds(await response.json())
    ).pipe(
      Effect.map((ids): SourceResult => {
        const models = idMap([...ids], keyOf);
        return {
          models,
          providerConfig: new Map([...models.keys()].map((key) => [key, { authless: true, free: true }])),
          managedKeys: ["authless", "free"],
        };
      }),
      Effect.mapError((cause) => ({ provider: "kilo_code", message: cause.message }))
    ),
};
