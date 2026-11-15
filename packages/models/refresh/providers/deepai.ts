import { Effect } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";
import { idMap } from "@opendum/models/model-store";
import { fetchText } from "@opendum/models/sync/http";
import { standardKey } from "@opendum/models/refresh/core/keys";
import { sourceOf, type ModelSource, type SourceResult } from "@opendum/models/refresh/core/types";

const PAGE_URL = "https://deepai.org/chat/ai-code";
const EXCLUDED_IDS = new Set(["gpt-oss-120b"]);

const MODEL_CODE = /<code>deepai\/([a-z0-9.-]+)<\/code>/g;
const FREE_ROW = /(?<![\d~])0 Theos\/request/g;
const METERED_ROW = /~\d+ Theos\/request/g;

const pageIds = (html: string): ReadonlyArray<string> =>
  [...html.matchAll(MODEL_CODE)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .filter((id, index, all) => !EXCLUDED_IDS.has(id) && all.indexOf(id) === index);

const pageFreeCount = (html: string, total: number): number => {
  const free = (html.match(FREE_ROW) ?? []).length;
  const metered = (html.match(METERED_ROW) ?? []).length;
  if (free === 0 || free + metered !== total) raise(new Error("unexpected DeepAI catalog page layout"));
  return free;
};

const pageResult = (html: string): SourceResult => {
  const ids = pageIds(html);
  if (ids.length === 0) raise(new Error("unexpected DeepAI catalog page"));

  const free = pageFreeCount(html, ids.length);
  const freeIds = new Set(ids.slice(0, free));
  const models = idMap([...ids], standardKey);
  const providerConfig = new Map(
    [...models.entries()].flatMap(([key, id]) => (freeIds.has(id) ? [[key, { free: true }] as const] : []))
  );
  return {
    ...sourceOf(models),
    providerConfig,
    managedKeys: ["free"],
  };
};

export const deepaiSource: ModelSource = {
  provider: "deepai",
  label: "DeepAI",
  order: 85,
  phase: "fetch",

  fetch: () =>
    fetchText(PAGE_URL, { label: "DeepAI catalog page" }).pipe(
      Effect.map(pageResult),
      Effect.mapError((cause) => ({ provider: "deepai", message: cause.message }))
    ),
};
