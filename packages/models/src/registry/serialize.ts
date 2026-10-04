import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue, ModelData } from "#models/model/types.ts";

const MODEL_PROPERTY_ORDER = [
  "id",
  "providers",
  "aliases",
  "description",
  "ignored",
  "reasoning",
  "reasoning_effort",
  "modalities",
  "limit",
  "cost",
  "scores",
  "providerConfig",
];

const PROVIDER_CONFIG_PROPERTY_ORDER = ["upstream", "contextWindow", "maxOutputTokens", "authless", "free", "minTier", "allowedTiers", "aliases"];
const COST_PROPERTY_ORDER = ["input", "output", "cacheRead", "cacheWrite"];
const SCORE_PROPERTY_ORDER = ["index", "estimated", "version"];

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function orderObject(value: Record<string, JsonValue>, preferredKeys: string[] = []): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  const preferred = new Set(preferredKeys);

  for (const key of preferredKeys) {
    if (value[key] !== undefined) {
      result[key] = orderValue(value[key], key);
    }
  }

  for (const key of Object.keys(value).filter((key) => !preferred.has(key)).sort()) {
    if (value[key] !== undefined) {
      result[key] = orderValue(value[key], key);
    }
  }

  return result;
}

function orderProviderMap(value: Record<string, JsonValue>, preferredKeys: string[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const provider of Object.keys(value).sort()) {
    const entry = value[provider];
    result[provider] = isPlainObject(entry)
      ? orderObject(entry, preferredKeys)
      : orderValue(entry!, provider);
  }
  return result;
}

function orderValue(value: JsonValue, key?: string): JsonValue {
  if (key === "aliases" && Array.isArray(value)) return [...(value as string[])].sort();
  if (Array.isArray(value)) return value.map((item) => orderValue(item));
  if (!isPlainObject(value)) return value;

  if (key === "providerConfig") return orderProviderMap(value, PROVIDER_CONFIG_PROPERTY_ORDER);
  if (key === "cost") return orderObject(value, COST_PROPERTY_ORDER);
  if (key === "scores") return orderScores(value);
  return orderObject(value);
}

function orderScores(value: JsonValue): JsonValue {
  if (!isPlainObject(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = orderObject(value[key] as Record<string, JsonValue>, SCORE_PROPERTY_ORDER);
  }
  return result;
}

function normalizeModelData(data: ModelData): Record<string, JsonValue> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    delete data.family;
  }
  return orderObject(data as Record<string, JsonValue>, MODEL_PROPERTY_ORDER);
}

export function readModelJson(content: string): ModelData {
  return JSON.parse(content) as ModelData;
}

export function writeModelJson(filePath: string, data: ModelData): void {
  const content = JSON.stringify(normalizeModelData(data), null, 2);
  writeFileSync(filePath, `${content}\n`);
}

export function writeGeneratedModelJson(filePath: string, data: ModelData): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeModelJson(filePath, data);
}
