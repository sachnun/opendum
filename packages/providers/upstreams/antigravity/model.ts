import { Value } from "../../core/helpers.js";
import type { Registry } from "@opendum/models/runtime";
import type { Json } from "./common.js";

const GEMINI_FLASH_BUDGETS: Record<string, number> = { minimal: 1024, low: 1024, medium: 8192, high: 16384 };
const GEMINI_PRO_BUDGETS: Record<string, number> = { minimal: 1024, low: 2048, medium: 16384, high: 32768 };
const EFFORT_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 1024,
  medium: 10000,
  high: 32000,
  xhigh: 32000,
};

export class GeminiModel {
  static segment(model: string): string {
    const parts = model.split("/");
    return parts[parts.length - 1];
  }

  static isGemini3(model: string): boolean {
    return GeminiModel.segment(model).includes("gemini-3");
  }

  static isTieredGemini3(model: string): boolean {
    return GeminiModel.isGemini3(model) && GeminiModel.levelFromName(model) !== "";
  }

  static levelFromName(model: string): string {
    const name = GeminiModel.segment(model);
    for (const level of ["minimal", "low", "medium", "high"]) {
      if (name.endsWith(`-${level}`)) return level;
    }
    return "";
  }

  static trimThinkingLevel(model: string): string {
    const level = GeminiModel.levelFromName(model);
    if (!level) return model;
    return model.slice(0, -(level.length + 1));
  }

  static budgetFor(effort: string): number {
    return EFFORT_BUDGETS[effort] ?? 0;
  }

  static tieredBudgets(model: string): Record<string, number> {
    return GeminiModel.segment(model).includes("flash") ? GEMINI_FLASH_BUDGETS : GEMINI_PRO_BUDGETS;
  }

  static normalizeTiered(registry: Registry, model: string): string {
    if (!registry.supportsProvider(model, "antigravity")) return model;
    return registry.upstream(model, "antigravity");
  }

  static configValue(registry: Registry, model: string, key: string): { found: boolean; value: unknown } {
    const cfg = registry.config(model, "antigravity");
    if (!cfg) return { found: false, value: undefined };
    if (key in cfg) return { found: true, value: cfg[key] };
    const custom = cfg.custom;
    if (custom && typeof custom === "object" && key in custom) {
      return { found: true, value: (custom as Json)[key] };
    }
    return { found: false, value: undefined };
  }

  static resolve(registry: Registry, model: string): string {
    const direct = GeminiModel.normalizeTiered(registry, model);
    if (direct !== model) return direct;
    const trimmed = GeminiModel.trimThinkingLevel(model);
    if (trimmed !== model) return GeminiModel.normalizeTiered(registry, trimmed);
    return model;
  }

  static needsSystemInstruction(model: string): boolean {
    const normalized = GeminiModel.segment(model).toLowerCase();
    if (normalized.includes("image")) return false;
    return normalized.includes("claude") || GeminiModel.isGemini3(normalized);
  }

  static bool(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  static float(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  static numericSession(sessionId: string): string {
    let hash = 0;
    for (const char of sessionId) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return String(hash);
  }

  static stableSession(body: Json): string {
    const raw = Value.string(body._sessionId) || Value.string(body.user) || Value.string(body.session_id);
    return raw ? GeminiModel.numericSession(raw) : "0";
  }
}

export class GeminiTier {
  static normalize(id: string): string {
    return id.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  static paid(id: string): boolean {
    const normalized = GeminiTier.normalize(id);
    return normalized !== "" && normalized !== "free" && normalized !== "free-tier";
  }
}
