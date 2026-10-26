import { buildIndex, persist, sync } from "#models/model-store.ts";
import { fetchDecoded, fetchText, orThrow } from "#models/sync/http.ts";
import { arrayAt, trimmed, booleanAt, stringAt } from "#models/json.ts";
import { dataDir, runScript } from "./shared.ts";
import type { JsonValue } from "#models/types.ts";

const CODEX_MODELS_URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";

const CHATGPT_SUPPORTED_VISIBILITY = "list";

const PRICING_URL = "https://learn.chatgpt.com/docs/pricing.md";
const FREE_PLAN_NAMES = new Set(["Free", "Go"]);
const PAID_CODEX_TIERS = [
  "plus",
  "pro",
  "pro+",
  "business",
  "enterprise",
  "team",
  "student",
];

interface CodexModel {
  slug: string;
  displayName: string | null;
  hasReasoning: boolean;
}

function toModel(item: unknown): CodexModel | null {
  const slug = trimmed(stringAt(item, "slug"));
  if (!slug) return null;

  const visibility = stringAt(item, "visibility");
  if (visibility && visibility !== CHATGPT_SUPPORTED_VISIBILITY) return null;
  if (booleanAt(item, "supported_in_api") === false) return null;

  const displayName = trimmed(stringAt(item, "display_name")) ?? null;
  const hasReasoning = arrayAt(item, "supported_reasoning_levels").length > 0;
  return { slug, displayName, hasReasoning };
}

async function fetchModels(): Promise<CodexModel[]> {
  return orThrow(
    fetchDecoded(
      CODEX_MODELS_URL,
      { label: "Codex CLI models", headers: { Accept: "application/json" } },
      async (response) => {
        const payload = await response.json();
        const models = arrayAt(payload, "models");
        if (models.length === 0) {
          throw new Error("Unexpected Codex models.json payload format");
        }
        return models.flatMap((item) => {
          const model = toModel(item);
          return model ? [model] : [];
        });
      }
    )
  );
}

function modelIndex(models: CodexModel[]): Map<string, string> {
  return new Map(
    models
      .map((model): [string, string] => [model.slug, model.slug])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function planNames(): Promise<string> {
  const markdown = await fetchText(PRICING_URL, {
    label: "Codex pricing docs",
    headers: { Accept: "text/markdown" },
  });

  const mentions: string[] = [];
  for (const match of markdown.matchAll(/<PricingCard([\s\S]*?)<\/PricingCard>/g)) {
    const body = match[1] ?? "";
    const name = body.match(/name="([^"]+)"/)?.[1] ?? "";
    if (!FREE_PLAN_NAMES.has(name)) continue;
    for (const line of body.split(/\r?\n/)) {
      const bullet = line.match(/^\s*-\s+(.*)$/)?.[1];
      if (bullet) mentions.push(normalizeName(bullet));
    }
  }

  return mentions.join(" ");
}

function tierMap(
  models: CodexModel[],
  freePlanMentions: string
): Map<string, Record<string, JsonValue>> {
  const providerConfig = new Map<string, Record<string, JsonValue>>();
  if (!freePlanMentions) return providerConfig;

  for (const model of models) {
    const name = normalizeName(model.displayName ?? model.slug);
    if (name && freePlanMentions.includes(name)) continue;
    providerConfig.set(model.slug, { allowedTiers: PAID_CODEX_TIERS });
  }

  return providerConfig;
}

function enrichModels(modelsDir: string, addedKeys: string[], lookup: Map<string, CodexModel>): void {
  const index = buildIndex(modelsDir);

  for (const modelKey of addedKeys) {
    const entry = Object.values(index).find(
      (item) => item.fileId === modelKey || item.id === modelKey
    );
    if (!entry) continue;

    const meta = lookup.get(modelKey);
    if (!meta || !meta.hasReasoning) continue;
    if (entry.data.reasoning === true) continue;

    entry.data.reasoning = true;
    persist(entry, entry.data);
  }
}

async function main(): Promise<void> {
  const modelsDir = dataDir();

  const models = await fetchModels();
  const modelMap = modelIndex(models);
  const lookup = new Map(models.map((model) => [model.slug, model]));

  let freePlanMentions = "";
  try {
    freePlanMentions = await planNames();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex] Could not load pricing docs for tier gating (${message}); skipping gating.`);
  }

  const providerConfig = tierMap(models, freePlanMentions);
  if (providerConfig.size > 0) {
    console.log(
      `[codex] Paid-plan models (gated by allowedTiers): ${[...providerConfig.keys()].join(", ")}`
    );
  }

  const result = await sync(modelsDir, "codex", modelMap, {
    providerConfig,
    managedProviderConfigKeys: ["allowedTiers"],
  });

  if (result.added.length > 0) {
    enrichModels(modelsDir, result.added, lookup);
  }

  if (result.added.length === 0 && result.removed.length === 0 && result.updated.length === 0) {
    console.log(`Codex CLI models are already up to date (${modelMap.size} models).`);
  } else {
    console.log(
      `Codex ChatGPT-compatible models: ${modelMap.size} models (added ${result.added.length}, removed ${result.removed.length}, updated ${result.updated.length}).`
    );
  }
}

runScript(main);
