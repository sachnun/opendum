import { Effect, Option, Schema } from "effect";
import { buildIndex, upstream } from "@opendum/models/model-store";
import { entryFor, slugify, writeEntry } from "@opendum/models/refresh/core/keys";
import { env } from "@opendum/models/refresh/core/env";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";

const PROVIDER = "workers_ai";
const API_URL =
  "https://api.github.com/repos/cloudflare/cloudflare-docs/contents/src/content/workers-ai-models?ref=production";
const CONCURRENCY = 8;
const EXCLUDED = ["guard"];

const File = Schema.Struct({ type: Schema.String, name: Schema.String, download_url: Schema.String });
const Model = Schema.Record(Schema.String, Schema.Unknown);

type File = typeof File.Type;
type Capabilities = { reasoning: boolean; modalities: { input: string[]; output: string[] } };

const decodeFile = Schema.decodeUnknownOption(File);
const decodeModel = Schema.decodeUnknownOption(Model);

const token = (): string | undefined => env("GITHUB_TOKEN") ?? env("GH_TOKEN");

const headers = (): Record<string, string> => {
  const value = token();
  return value ? { Authorization: `Bearer ${value}`, Accept: "application/json" } : { Accept: "application/json" };
};

const fetchJson = (url: string, label: string): Effect.Effect<unknown> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, { headers: headers() });
      if (!response.ok) throw new Error(`failed to fetch ${label} (${response.status})`);
      return (await response.json()) as unknown;
    },
    catch: (cause) => cause,
  }).pipe(Effect.orDie);

const files = (payload: unknown): ReadonlyArray<File> => {
  if (!Array.isArray(payload)) throw new Error("unexpected Cloudflare Workers AI model file list payload");
  return payload
    .flatMap((entry) =>
      Option.match(decodeFile(entry), {
        onNone: () => [],
        onSome: (file) =>
          file.type === "file" && file.name.endsWith(".json") && file.download_url
            ? [{ ...file, name: file.name.replace(/\.json$/, "") }]
            : [],
      })
    )
    .sort((left, right) => left.name.localeCompare(right.name));
};

const property = (model: Record<string, unknown>, id: string): unknown => {
  const list = Array.isArray(model.properties) ? model.properties : [];
  const found = list.find(
    (entry) => entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).property_id === id
  );
  return found !== null && typeof found === "object"
    ? (found as Record<string, unknown>).value
    : undefined;
};

const truthy = (value: unknown): boolean => value === true || value === "true";

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const supportsMessages = (value: unknown, depth = 0): boolean => {
  if (depth > 64 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((item) => supportsMessages(item, depth + 1));
  const entry = record(value);
  if (!entry) return false;
  const properties = record(entry.properties);
  if (properties?.messages) return true;
  return Object.values(entry).some((item) => supportsMessages(item, depth + 1));
};

const normalizeKey = (value: string): string =>
  slugify(value.replace(/^@[^/]+\//, "")).replace(/^-+|-+$/g, "");

const deriveFamily = (key: string): string | undefined => {
  if (/^kimi-/i.test(key)) return "Moonshot";
  if (/^glm-/i.test(key)) return "Z.AI";
  if (/^gpt-|^o\d/i.test(key)) return "OpenAI";
  if (/^gemma/i.test(key)) return "Gemini";
  if (/^llama|^meta-llama/i.test(key)) return "Meta";
  if (/^qwen|^qwq-/i.test(key)) return "Qwen";
  if (/^deepseek-/i.test(key)) return "DeepSeek";
  if (/^mistral-|^mixtral|^codestral|^devstral|^ministral|^mamba-codestral|^magistral/i.test(key)) return "Mistral";
  if (/^nemotron-/i.test(key)) return "NVIDIA";
  if (/^granite-/i.test(key)) return "IBM";
  if (/^phi-/i.test(key)) return "Microsoft";
  return undefined;
};

const capabilities = (model: Record<string, unknown>): Capabilities => ({
  reasoning: truthy(property(model, "reasoning")),
  modalities: {
    input: truthy(property(model, "vision")) ? ["text", "image"] : ["text"],
    output: ["text"],
  },
});

const reverseIndex = (modelsDir: string): ReadonlyMap<string, string> => {
  const map = new Map<string, string>();
  for (const [modelId, entry] of Object.entries(buildIndex(modelsDir))) {
    if (!(entry.data.providers ?? []).includes(PROVIDER)) continue;
    const name = upstream(entry.data, PROVIDER, modelId);
    if (name) map.set(name, entry.id || modelId);
  }
  return map;
};

const ignored = (modelsDir: string, key: string): boolean => {
  const found = entryFor(modelsDir, key);
  if (found._tag === "None") return false;
  if (!found.value.data.ignored) return false;
  return !(found.value.data.providers ?? []).includes(PROVIDER);
};

const include = (
  model: Record<string, unknown>,
  key: string,
  modelsDir: string,
  existing: boolean
): boolean => {
  const name = typeof model.name === "string" ? model.name.trim() : "";
  if (!name || !name.startsWith("@")) return false;
  const task = record(model.task);
  if (task?.name !== "Text Generation") return false;
  if (!supportsMessages(record(record(model.schema)?.input))) return false;
  if (truthy(property(model, "lora"))) return false;
  if (truthy(property(model, "require_workers_paid"))) return false;
  if (property(model, "planned_deprecation_date") && !existing) return false;
  if (ignored(modelsDir, key)) return false;
  return !EXCLUDED.some((entry) => key.toLowerCase().includes(entry));
};

export const cloudflareSource: ModelSource = {
  provider: PROVIDER,
  label: "Cloudflare",
  order: 25,
  phase: "fetch",

  fetch: (ctx) =>
    Effect.gen(function* () {
      const payload = yield* fetchJson(API_URL, "Cloudflare model index");
      const catalog = files(payload);
      if (catalog.length === 0) throw new Error("Cloudflare model index is empty");

      const reverse = reverseIndex(ctx.modelsDir);
      const models = new Map<string, string>();
      const metadata = new Map<string, Record<string, unknown>>();

      const batches = Array.from({ length: Math.ceil(catalog.length / CONCURRENCY) }, (_, index) =>
        catalog.slice(index * CONCURRENCY, (index + 1) * CONCURRENCY)
      );

      for (const batch of batches) {
        const resolved = yield* Effect.forEach(
          batch,
          (file) =>
            fetchJson(file.download_url, `Workers AI model ${file.name}`).pipe(
              Effect.map((model) => ({ slug: file.name, model }))
            ),
          { concurrency: CONCURRENCY }
        );

        for (const item of resolved) {
          const parsed = Option.getOrElse(decodeModel(item.model), () => null);
          if (!parsed) continue;

          const upstreamName = typeof parsed.name === "string" ? parsed.name.trim() : "";
          const existing = reverse.has(upstreamName);
          const key = reverse.get(upstreamName) ?? normalizeKey(item.slug || upstreamName);
          if (!key || !include(parsed, key, ctx.modelsDir, existing)) continue;

          models.set(key, upstreamName);
          const caps = capabilities(parsed);
          metadata.set(key, {
            family: deriveFamily(key),
            reasoning: caps.reasoning,
            modalities: caps.modalities,
          });
        }
      }

      if (models.size === 0) throw new Error("Cloudflare resolved no models");

      return {
        ...sourceOf(new Map([...models.entries()].sort(([left], [right]) => left.localeCompare(right)))),
        extra: new Map([["metadata", metadata]]),
      } satisfies SourceResult;
    }).pipe(
      Effect.mapError((cause: unknown) => ({
        provider: PROVIDER,
        message: cause instanceof Error ? cause.message : String(cause),
      }))
    ),

  enrich: (ctx, result, outcome) =>
    Effect.gen(function* () {
      const metadata = Option.match(Option.fromNullishOr(result.extra?.get("metadata")), {
        onNone: () => new Map<string, Record<string, unknown>>(),
        onSome: (value) => value as Map<string, Record<string, unknown>>,
      });
      const touched = new Set([...outcome.added, ...outcome.updated]);
      if (metadata.size === 0 || touched.size === 0) return [] as ReadonlyArray<string>;

      let updated = 0;
      for (const key of touched) {
        const info = metadata.get(key);
        if (!info) continue;
        const found = entryFor(ctx.modelsDir, key);
        if (found._tag === "None") continue;

        const data = found.value.data;
        let dirty = false;
        if (info.reasoning !== undefined && data.reasoning === undefined) {
          data.reasoning = info.reasoning as boolean;
          dirty = true;
        }
        if (info.modalities !== undefined && data.modalities === undefined) {
          data.modalities = info.modalities as { input: string[]; output: string[] };
          dirty = true;
        }
        if (!dirty) continue;
        yield* writeEntry(found.value, data);
        updated += 1;
      }

      return updated > 0 ? [`[Cloudflare] applied metadata to ${updated} model(s)`] : [];
    }),
};
