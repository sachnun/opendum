import type { Registry } from "../registry/index.js";
import { providerConfigBool, normalizeAntigravityTieredModel } from "./model_helpers.js";

export function providerConfigBoolHelper(registry: Registry | null, model: string, provider: string, key: string): boolean {
  if (!registry) return false;
  let cfg = registry.providerModelConfig(model, provider);
  if (!cfg && provider === "antigravity") {
    const normalized = normalizeAntigravityTieredModel(model);
    if (normalized !== model) cfg = registry.providerModelConfig(normalized, provider);
  }
  if (!cfg || !cfg.custom) return false;
  return cfg.custom[key] === true;
}

export function normalizeToolChoiceHelper(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const choice = value as Record<string, unknown>;
  if (choice["type"] !== "function") return value;
  const fn = (choice["function"] ?? {}) as Record<string, unknown>;
  let name = typeof fn["name"] === "string" ? fn["name"] : "";
  if (name === "") name = typeof choice["name"] === "string" ? choice["name"] : "";
  if (name === "") return value;
  return { type: "function", name };
}
