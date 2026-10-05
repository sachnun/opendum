import { createHash } from "node:crypto";

import { cloneAnyMap, numberFromAny } from "#providers/lib/helpers.ts";
import { type Json } from "#providers/providers/antigravity/config.ts";
import { isGemini3ModelName, lastModelSegment, numberAsFloat } from "#providers/providers/antigravity/model-config.ts";
import { SIGNATURE_CACHE_PREFIX, type AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";

export const ANTIGRAVITY_CLAUDE_FLAGS = new Set([
  "anthropic_beta",
  "anthropic_beta_thinking",
  "convert_external_images",
  "force_stream_non_stream",
  "sanitize_tool_blocks",
  "strict_thought_signatures",
  "strict_tool_schema",
  "system_instruction",
  "thinking_model",
  "top_p_min_095",
]);

export const GEMINI_THINKING_LEVELS: Json = {
  high: "high",
  low: "low",
  medium: "medium",
  none: "minimal",
  xhigh: "high",
};

export const GEMINI_FLASH_THINKING_BUDGETS: Json = { high: 24576, low: 6144, medium: 12288, xhigh: 24576 };
export const GEMINI_PRO_THINKING_BUDGETS: Json = { high: 32768, low: 8192, medium: 16384, xhigh: 32768 };

function normalizeAntigravityTieredModel(model: string): string {
  const value = model.trim().toLowerCase();
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value;
}

function derivedConfigValue(model: string, key: string): { found: boolean; value: unknown } {
  const name = normalizeAntigravityTieredModel(model);
  if (name.startsWith("gemini-")) {
    const image = name.includes("image");
    const pro = name.includes("pro");
    const levelThinking = name.startsWith("gemini-3") && !pro && !image;
    switch (key) {
      case "inject_thought_signature":
      case "scrub_model_artifacts":
        return { found: true, value: true };
      case "signature_family":
        return { found: true, value: "gemini-flash" };
      case "system_instruction":
        return { found: true, value: name.startsWith("gemini-3") && !image };
      case "thinking_format":
        if (image) return { found: false, value: undefined };
        return { found: true, value: levelThinking ? "level" : "budget" };
      case "thinking_levels":
        return levelThinking ? { found: true, value: GEMINI_THINKING_LEVELS } : { found: false, value: undefined };
      case "thinking_budgets":
        if (image || levelThinking) return { found: false, value: undefined };
        return { found: true, value: pro ? GEMINI_PRO_THINKING_BUDGETS : GEMINI_FLASH_THINKING_BUDGETS };
      default:
        return { found: false, value: undefined };
    }
  }
  if (name.startsWith("claude-")) {
    if (ANTIGRAVITY_CLAUDE_FLAGS.has(key)) return { found: true, value: true };
    if (key === "signature_family") return { found: true, value: "claude" };
  }
  return { found: false, value: undefined };
}

export function configValue(rt: AntigravityRuntime, model: string, key: string): unknown {
  const cfg = rt.registry.providerModelConfig(model, rt.name);
  if (cfg) {
    if (key in cfg) return cfg[key];
    const custom = cfg.custom;
    if (custom && typeof custom === "object" && key in custom) return custom[key];
  }
  const derived = derivedConfigValue(model, key);
  return derived.found ? derived.value : undefined;
}

export function configBool(rt: AntigravityRuntime, model: string, key: string): boolean {
  return configValue(rt, model, key) === true;
}

export function configString(rt: AntigravityRuntime, model: string, key: string): string {
  const value = configValue(rt, model, key);
  return typeof value === "string" ? value.trim() : "";
}

export function configStringMap(rt: AntigravityRuntime, model: string, key: string): Record<string, string> {
  const value = configValue(rt, model, key);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Json)) {
    if (typeof entryValue === "string" && entryValue.trim()) out[entryKey] = entryValue.trim();
  }
  return out;
}

export function configIntMap(rt: AntigravityRuntime, model: string, key: string): Record<string, number> {
  const value = configValue(rt, model, key);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Json)) {
    const num = numberFromAny(entryValue);
    if (num !== 0) out[entryKey] = num;
  }
  return out;
}

export function resolveModel(rt: AntigravityRuntime, model: string): string {
  let value = lastModelSegment(model);
  if (value.endsWith(":thinking")) value = value.slice(0, -":thinking".length);
  return rt.registry.upstreamModelName(value, rt.name);
}

export function normalizeBodyForModel(rt: AntigravityRuntime, body: Json, model: string): Json {
  const out = cloneAnyMap(body);
  delete out.logit_bias;
  if (configBool(rt, model, "top_p_min_095")) {
    const topP = numberAsFloat(out.top_p);
    if (topP !== null && topP < 0.95) delete out.top_p;
  }
  return out;
}

export function shouldSetAnthropicBeta(rt: AntigravityRuntime, model: string): boolean {
  if (configBool(rt, model, "anthropic_beta")) return true;
  return model.includes("claude") && model.includes("thinking");
}

export function signatureFamily(rt: AntigravityRuntime, model: string): string {
  return configString(rt, model, "signature_family") || configString(rt, model, "transform");
}

export function signatureCacheKey(rt: AntigravityRuntime, model: string, sessionId: string, thoughtText: string): string {
  const hash = createHash("sha256")
    .update(`${signatureFamily(rt, model)}:${sessionId}:${thoughtText.trim()}`)
    .digest("hex");
  return `${SIGNATURE_CACHE_PREFIX}:${hash}`;
}

export function thinkingLevel(rt: AntigravityRuntime, model: string, effort: string): string {
  const levels = configStringMap(rt, model, "thinking_levels");
  if (Object.keys(levels).length === 0) return "";
  return levels[effort] || levels.high || "";
}

export function normalizeGemini3ThinkingLevel(model: string, level: string): string {
  const value = level.trim().toLowerCase();
  switch (value) {
    case "xhigh":
      return "high";
    case "minimal":
      return model.toLowerCase().includes("pro") ? "low" : "minimal";
    case "medium": {
      const lower = model.toLowerCase();
      if (lower.includes("pro") && !lower.includes("gemini-3.1-pro")) return "high";
      return "medium";
    }
    case "low":
    case "high":
      return value;
    default:
      return "";
  }
}

export function thinkingLevelFromBudget(rt: AntigravityRuntime, model: string, budget: number): string {
  let effort = "high";
  const budgets = configIntMap(rt, model, "thinking_budgets");
  const low = budgets.low ?? 0;
  const medium = budgets.medium ?? 0;
  if (low > 0 && budget <= low) effort = "low";
  else if (medium > 0 && budget <= medium) effort = "medium";
  else if (Object.keys(budgets).length === 0) {
    if (budget <= 8192) effort = "low";
    else if (budget <= 16384) effort = "medium";
  }
  const level = thinkingLevel(rt, model, effort);
  return normalizeGemini3ThinkingLevel(model, level || effort);
}

export function thinkingLevelFromEffort(rt: AntigravityRuntime, model: string, effort: string): string {
  const level = thinkingLevel(rt, model, effort);
  return normalizeGemini3ThinkingLevel(model, level || effort);
}

export function fallbackAntigravitySystemInstructionModel(model: string): boolean {
  const normalized = lastModelSegment(model).toLowerCase();
  if (normalized.includes("image")) return false;
  return normalized.includes("claude") || isGemini3ModelName(normalized);
}
