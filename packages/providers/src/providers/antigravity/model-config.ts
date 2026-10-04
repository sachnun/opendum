import { createHash } from "node:crypto";
import { cloneAnyMap, defaultStringValue, numberFromAny, stringValue } from "#providers/lib/helpers.ts";
import { defaultAny, type Json } from "#providers/providers/antigravity/config.ts";
import { normalizedThinkingMap } from "#providers/providers/antigravity/payload.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, MIN_THINKING_BUDGET, SIGNATURE_CACHE_PREFIX, type AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";

export function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

export function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function numberAsFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

export function isGemini3ModelName(model: string): boolean {
  return lastModelSegment(model).toLowerCase().startsWith("gemini-3");
}

export function isTieredGemini3Model(model: string): boolean {
  const value = lastModelSegment(model).toLowerCase();
  return value.startsWith("gemini-3") && value.endsWith("-tiered");
}

export function geminiThinkingLevelFromModel(model: string): string {
  const value = lastModelSegment(model).toLowerCase();
  for (const level of ["minimal", "low", "medium", "high"]) {
    if (value.endsWith(`-${level}`)) return level;
  }
  return "";
}

export function trimGeminiThinkingLevelSuffix(model: string): string {
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (model.toLowerCase().endsWith(suffix)) return model.slice(0, model.length - suffix.length);
  }
  return model;
}

export function defaultThinkingBudget(effort: string): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 10000;
    case "high":
    case "xhigh":
      return 32000;
    default:
      return 0;
  }
}

export function normalizeGoogleTierId(id: string): string {
  return id.trim().toLowerCase();
}

export function isPaidGoogleTierId(id: string): boolean {
  const lower = normalizeGoogleTierId(id);
  return lower === "paid" || lower === "standard-tier";
}

export function fallbackAntigravitySystemInstructionModel(model: string): boolean {
  const normalized = lastModelSegment(model).toLowerCase();
  if (normalized.includes("image")) return false;
  return normalized.includes("claude") || isGemini3ModelName(normalized);
}

const ANTIGRAVITY_CLAUDE_FLAGS = new Set([
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

const GEMINI_THINKING_LEVELS: Json = {
  high: "high",
  low: "low",
  medium: "medium",
  none: "minimal",
  xhigh: "high",
};

const GEMINI_FLASH_THINKING_BUDGETS: Json = { high: 24576, low: 6144, medium: 12288, xhigh: 24576 };
const GEMINI_PRO_THINKING_BUDGETS: Json = { high: 32768, low: 8192, medium: 16384, xhigh: 32768 };

function normalizeAntigravityTieredModel(model: string): string {
  const value = model.trim().toLowerCase();
  for (const suffix of ["-minimal", "-low", "-medium", "-high"]) {
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  return value;
}

// Antigravity request shaping is fixed per model family, so it is derived from
// the model name rather than stored in the registry. Registry values still win
// when an authored model config provides them.
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

function thinkingLevel(rt: AntigravityRuntime, model: string, effort: string): string {
  const levels = configStringMap(rt, model, "thinking_levels");
  if (Object.keys(levels).length === 0) return "";
  return levels[effort] || levels.high || "";
}

function normalizeGemini3ThinkingLevel(model: string, level: string): string {
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

export function requestedGemini3ThinkingLevel(rt: AntigravityRuntime, model: string, body: Json): string {
  const thinking = body.thinking;
  if (thinking !== null && typeof thinking === "object" && !Array.isArray(thinking)) {
    const t = thinking as Json;
    const level = normalizeGemini3ThinkingLevel(model, stringValue(t.thinkingLevel));
    if (level) return level;
    const budget = numberFromAny(t.budget_tokens);
    if (budget > 0) return thinkingLevelFromBudget(rt, model, budget);
  }
  const bodyBudget = numberFromAny(body.thinking_budget);
  if (bodyBudget > 0) return thinkingLevelFromBudget(rt, model, bodyBudget);
  const effort = stringValue(body.reasoning_effort);
  if (effort) {
    const level = thinkingLevelFromEffort(rt, model, effort);
    if (level) return level;
  }
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const rEffort = stringValue((reasoning as Json).effort);
    if (rEffort) {
      const level = thinkingLevelFromEffort(rt, model, rEffort);
      if (level) return level;
    }
  }
  return "";
}

export function resolveAntigravityGemini3ModelVariant(rt: AntigravityRuntime, model: string, body: Json): string {
  if (!isGemini3ModelName(model)) return model;
  const lower = model.toLowerCase();
  if (lower.startsWith("gemini-3.5-flash") && !lower.includes("lite")) {
    const base = trimGeminiThinkingLevelSuffix(model);
    let level = geminiThinkingLevelFromModel(model);
    const bodyLevel = requestedGemini3ThinkingLevel(rt, model, body);
    if (bodyLevel) level = bodyLevel;
    if (!level) level = "medium";
    return `${base}-${level}`;
  }
  if (!model.toLowerCase().includes("pro")) return model;
  const base = trimGeminiThinkingLevelSuffix(model);
  let level = geminiThinkingLevelFromModel(model);
  const bodyLevel = requestedGemini3ThinkingLevel(rt, model, body);
  if (bodyLevel) level = bodyLevel;
  if (!level) level = "high";
  return `${base}-${level}`;
}

function fitGemini3ThinkingLevel(rt: AntigravityRuntime, generation: Json, model: string, level: string): string {
  const maxTokens = numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
  if (maxTokens <= 0) return level;
  const budgets = configIntMap(rt, model, "thinking_budgets");
  if (Object.keys(budgets).length === 0) return level;
  for (const candidate of ["minimal", "low", "medium", "high", "xhigh"]) {
    const budget = budgets[candidate] ?? 0;
    if (budget <= 0 || budget > maxTokens / 2) continue;
    const normalized = normalizeGemini3ThinkingLevel(model, candidate);
    return normalized || candidate;
  }
  return "";
}

function normalizeGemini3ThinkingConfig(rt: AntigravityRuntime, thinking: Json | null, model: string): Json | null {
  const out: Json = {};
  const include = defaultAny(thinking?.includeThoughts, thinking?.include_thoughts);
  if (typeof include === "boolean") out.includeThoughts = include;
  let level = defaultStringValue(thinking?.thinkingLevel, stringValue(thinking?.thinking_level));
  if (!level) {
    const budget = numberFromAny(defaultAny(thinking?.thinkingBudget, thinking?.thinking_budget));
    if (budget > 0) level = thinkingLevelFromBudget(rt, model, budget);
  } else {
    level = normalizeGemini3ThinkingLevel(model, level);
  }
  if (!level) level = geminiThinkingLevelFromModel(model);
  if (!level && lastModelSegment(model).toLowerCase().endsWith("-tiered")) level = "medium";
  if (level) {
    out.thinkingLevel = level;
    if (out.includeThoughts === undefined) out.includeThoughts = true;
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function applyThinkingConfig(rt: AntigravityRuntime, payload: Json, model: string, effort: string, budget: number): void {
  const config: Json = {};
  if (isGemini3ModelName(model)) {
    let level = "";
    if (budget > 0) level = thinkingLevelFromBudget(rt, model, budget);
    else if (effort && effort !== "none") level = thinkingLevelFromEffort(rt, model, effort);
    if (level) {
      config.thinkingLevel = level;
      config.includeThoughts = true;
    }
  } else {
    let format = configString(rt, model, "thinking_format");
    if (!format) format = "budget";
    if (budget > 0 && format !== "level") {
      config.thinkingBudget = budget;
      config.includeThoughts = true;
    } else if (effort && effort !== "none") {
      if (format === "level") {
        const level = thinkingLevel(rt, model, effort);
        if (level) config.thinkingLevel = level;
      } else {
        const budgets = configIntMap(rt, model, "thinking_budgets");
        const thinkingBudget = budgets[effort] > 0 ? budgets[effort] : budgets.high || 0;
        if (thinkingBudget > 0) config.thinkingBudget = thinkingBudget;
      }
      config.includeThoughts = true;
    }
  }
  if (Object.keys(config).length === 0) return;
  const generation = (payload.generationConfig ?? {}) as Json;
  generation.thinkingConfig = config;
  payload.generationConfig = generation;
}

export function normalizeThinkingConfig(rt: AntigravityRuntime, payload: Json, model: string): void {
  let generation = payload.generationConfig as Json | undefined;
  if (!generation || typeof generation !== "object") {
    if (configBool(rt, model, "thinking_model") || isTieredGemini3Model(model) || isGemini3ModelName(model)) {
      generation = {};
      payload.generationConfig = generation;
    } else {
      return;
    }
  }
  const rawThinking = (generation.thinkingConfig as Json | undefined) ?? null;
  if (isGemini3ModelName(model)) {
    const thinking = normalizeGemini3ThinkingConfig(rt, rawThinking, model);
    if (thinking) {
      const level = fitGemini3ThinkingLevel(rt, generation, model, stringValue(thinking.thinkingLevel));
      if (!level) {
        delete generation.thinkingConfig;
        return;
      }
      thinking.thinkingLevel = level;
      generation.thinkingConfig = thinking;
      const budgets = configIntMap(rt, model, "thinking_budgets");
      if ((budgets[level] ?? 0) > 0) {
        const maxTokens = numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
        if (maxTokens === 0) {
          generation.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
          delete generation.max_output_tokens;
        }
      }
    } else {
      delete generation.thinkingConfig;
    }
    return;
  }
  const thinking = normalizedThinkingMap(rawThinking);
  if (configBool(rt, model, "thinking_model")) {
    if (!thinking) {
      delete generation.thinkingConfig;
      if (numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens)) === 0) {
        generation.maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
        delete generation.max_output_tokens;
      }
      return;
    }
    if (thinking.include_thoughts === undefined && thinking.includeThoughts === undefined) {
      thinking.include_thoughts = true;
    }
    if (thinking.thinkingBudget === undefined && thinking.thinking_budget === undefined) {
      thinking.thinkingBudget = 16384;
    }
    let finalThinking = thinking;
    if (configBool(rt, model, "strict_tool_schema")) {
      const strict: Json = {
        include_thoughts: boolValue(defaultAny(thinking.include_thoughts, thinking.includeThoughts), true),
      };
      const budget = numberFromAny(defaultAny(thinking.thinkingBudget, thinking.thinking_budget));
      if (budget > 0) strict.thinking_budget = budget;
      finalThinking = strict;
    }
    generation.thinkingConfig = finalThinking;
    const budget = numberFromAny(defaultAny(thinking.thinkingBudget, thinking.thinking_budget));
    if (budget > 0) {
      let answer = numberFromAny(defaultAny(generation.maxOutputTokens, generation.max_output_tokens));
      if (answer <= 0) answer = DEFAULT_MAX_OUTPUT_TOKENS;
      let maxTokens = answer + budget;
      const cfg = rt.registry.providerModelConfig(model, rt.name);
      const limit = cfg?.maxOutputTokens ?? 0;
      if (limit > 0 && maxTokens > limit) maxTokens = limit;
      if (maxTokens <= budget) {
        const clamped = Math.floor(maxTokens / 2);
        if (clamped < MIN_THINKING_BUDGET) {
          delete generation.thinkingConfig;
          return;
        }
        if (finalThinking.thinkingBudget !== undefined) finalThinking.thinkingBudget = clamped;
        if (finalThinking.thinking_budget !== undefined) finalThinking.thinking_budget = clamped;
      }
      generation.maxOutputTokens = maxTokens;
      delete generation.max_output_tokens;
    }
    return;
  }
  if (thinking) generation.thinkingConfig = thinking;
  else delete generation.thinkingConfig;
}
