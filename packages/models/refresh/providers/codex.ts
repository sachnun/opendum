import { Effect, Option, Schema } from "effect";
import { fetchDecoded, fetchText } from "@opendum/models/sync/http";
import { entryFor, writeEntry } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";

const MODELS_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const PRICING_URL = "https://learn.chatgpt.com/docs/pricing.md";

const VISIBILITY = "list";
const FREE_PLAN_NAMES = new Set(["Free", "Go"]);
const PAID_TIERS = ["plus", "pro", "pro+", "business", "enterprise", "team", "student"];

const Entry = Schema.Struct({
  slug: Schema.String,
  display_name: Schema.optional(Schema.String),
  visibility: Schema.optional(Schema.String),
  supported_in_api: Schema.optional(Schema.Boolean),
  supported_reasoning_levels: Schema.optional(Schema.Array(Schema.Unknown)),
});
const Payload = Schema.Struct({ models: Schema.Array(Schema.Unknown) });
const PRICING_CARD = /<PricingCard([\s\S]*?)<\/PricingCard>/g;
const CARD_NAME = /name="([^"]+)"/;
const BULLET = /^\s*-\s+(.*)$/;

const decodePayload = Schema.decodeUnknownOption(Payload);
const decodeEntry = Schema.decodeUnknownOption(Entry);

type Entry = typeof Entry.Type;

const normalizeName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

const parseModels = (payload: unknown): ReadonlyArray<Entry> => {
  const data = Option.match(decodePayload(payload), {
    onNone: () => [] as ReadonlyArray<unknown>,
    onSome: (value) => value.models,
  });
  if (data.length === 0) throw new Error("unexpected Codex models.json payload");

  return data.flatMap((item) =>
    Option.match(decodeEntry(item), {
      onNone: () => [],
      onSome: (entry) => {
        if (entry.visibility !== undefined && entry.visibility !== VISIBILITY) return [];
        if (entry.supported_in_api === false) return [];
        return [entry];
      },
    })
  );
};

const freePlanMentions = (markdown: string): string => {
  const mentions: string[] = [];
  for (const match of markdown.matchAll(PRICING_CARD)) {
    const body = match[1] ?? "";
    const name = CARD_NAME.exec(body)?.[1] ?? "";
    if (!FREE_PLAN_NAMES.has(name)) continue;
    for (const line of body.split(/\r?\n/)) {
      const bullet = BULLET.exec(line)?.[1];
      if (bullet) mentions.push(normalizeName(bullet));
    }
  }
  return mentions.join(" ");
};

const tierConfig = (
  entries: ReadonlyArray<Entry>,
  mentions: string
): ReadonlyMap<string, Record<string, unknown>> => {
  const config = new Map<string, Record<string, unknown>>();
  if (!mentions) return config;
  for (const entry of entries) {
    const name = normalizeName(entry.display_name ?? entry.slug);
    if (name && mentions.includes(name)) continue;
    config.set(entry.slug, { allowedTiers: PAID_TIERS });
  }
  return config;
};

export const codexSource: ModelSource = {
  provider: "codex",
  label: "Codex",
  order: 15,
  phase: "fetch",

  fetch: () =>
    Effect.gen(function* () {
      const payload = yield* fetchDecoded(
        MODELS_URL,
        { label: "Codex CLI models", headers: { Accept: "application/json" } },
        async (response) => parseModels(await response.json())
      );
      const entries = payload;

      const mentions = yield* fetchText(PRICING_URL, {
        label: "Codex pricing docs",
        headers: { Accept: "text/markdown" },
      }).pipe(
        Effect.map(freePlanMentions),
        Effect.catchCause((cause) =>
          Effect.andThen(
            Effect.logWarning(`[Codex] pricing docs unavailable, skipping tier gating (${cause})`),
            Effect.succeed("")
          )
        )
      );

      const reasoning = new Set(
        entries
          .filter((entry) => (entry.supported_reasoning_levels ?? []).length > 0)
          .map((entry) => entry.slug)
      );

      return {
        ...sourceOf(new Map(entries.map((entry) => [entry.slug, entry.slug]))),
        providerConfig: tierConfig(entries, mentions),
        managedKeys: ["allowedTiers"],
        extra: new Map([["reasoningSlugs", reasoning]]),
      } satisfies SourceResult;
    }).pipe(Effect.mapError((cause) => ({ provider: "codex", message: cause.message }))),

  enrich: (ctx, result, outcome) =>
    Effect.gen(function* () {
      const reasoning = Option.match(Option.fromNullishOr(result.extra?.get("reasoningSlugs")), {
        onNone: () => new Set<string>(),
        onSome: (value) => value as Set<string>,
      });
      if (reasoning.size === 0 || outcome.added.length === 0) return [] as ReadonlyArray<string>;

      const marked = yield* Effect.forEach(
        outcome.added,
        (key) =>
          Effect.gen(function* () {
            if (!reasoning.has(key)) return null;
            const entry = entryFor(ctx.modelsDir, key);
            if (entry._tag === "None") return null;
            if (entry.value.data.reasoning === true) return null;
            entry.value.data.reasoning = true;
            yield* writeEntry(entry.value, entry.value.data);
            return key;
          }),
        { concurrency: 1 }
      );

      const updated = marked.filter((key): key is string => key !== null);
      return updated.length > 0 ? [`[Codex] marked ${updated.length} model(s) as reasoning`] : [];
    }),
};
