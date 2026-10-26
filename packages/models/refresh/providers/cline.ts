import { Effect, Option, Result, Schema } from "effect";
import { idMap } from "@opendum/models/model-store";
import { fetchJson } from "@opendum/models/sync/http";
import { slashedKey } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceFailure, type SourceResult } from "@opendum/models/refresh/core/types";

const MODELS_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";

const Payload = Schema.Struct({ free: Schema.Array(Schema.Unknown) });
const Entry = Schema.Struct({ id: Schema.String });

const decodePayload = Schema.decodeUnknownOption(Payload);
const decodeEntry = Schema.decodeUnknownOption(Entry);

const freeIds = (payload: unknown): Result.Result<ReadonlyArray<string>, string> => {
  const free = Option.match(decodePayload(payload), {
    onNone: () => [],
    onSome: (value) => value.free,
  });
  if (free.length === 0) return Result.fail("unexpected Cline recommended-models payload");

  const ids = free.flatMap((entry) =>
    Option.match(decodeEntry(entry), {
      onNone: () => [],
      onSome: (value) => [value.id],
    })
  );
  if (ids.length === 0) return Result.fail("Cline returned no free models");
  return Result.succeed(ids);
};

export const clineSource: ModelSource = {
  provider: "cline",
  label: "Cline",
  order: 10,
  phase: "fetch",

  fetch: () =>
    fetchJson(MODELS_URL, { label: "Cline recommended models" }).pipe(
      Effect.flatMap((payload): Effect.Effect<SourceResult, SourceFailure> => {
        const ids = freeIds(payload);
        if (Result.isFailure(ids)) return Effect.fail({ provider: "cline", message: ids.failure });
        return Effect.succeed(sourceOf(idMap([...ids.success], slashedKey)));
      }),
      Effect.mapError((cause) => ({ provider: "cline", message: cause.message }))
    ),
};
