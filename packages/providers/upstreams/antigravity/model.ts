import { Value } from "@opendum/providers/core/helpers";
import { ModelName } from "@opendum/providers/core/identity";
import type { Registry } from "@opendum/models/runtime";
import type { Json } from "@opendum/providers/upstreams/antigravity/common";

const GEMINI_FLASH_BUDGETS: Record<string, number> = { high: 24576, low: 6144, medium: 12288, xhigh: 24576 };
const GEMINI_PRO_BUDGETS: Record<string, number> = { high: 32768, low: 8192, medium: 16384, xhigh: 32768 };
const GEMINI_THINKING_LEVELS: Record<string, string> = {
  high: "high",
  low: "low",
  medium: "medium",
  none: "minimal",
  xhigh: "high",
};
const CLAUDE_FLAGS: ReadonlySet<string> = new Set([
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
const EFFORT_BUDGETS: Record<string, number> = {
  minimal: 1024,
  low: 1024,
  medium: 10000,
  high: 32000,
  xhigh: 32000,
};

export class GeminiModel {
  static segment(model: string): string {
    return ModelName.segment(model);
  }

  static isGemini3(model: string): boolean {
    const match = /^gemini-(\d+)/.exec(GeminiModel.segment(model).toLowerCase());
    return match !== null && Number(match[1]) >= 3;
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

  static familyModel(model: string): string {
    const name = GeminiModel.segment(model).toLowerCase();
    for (const level of ["minimal", "low", "medium", "high"]) {
      if (name.endsWith(`-${level}`)) return name.slice(0, -(level.length + 1));
    }
    return name;
  }

  static familyConfig(model: string, key: string): { found: boolean; value: unknown } {
    const name = GeminiModel.familyModel(model);
    if (name.startsWith("gemini-")) {
      const image = name.includes("image");
      const pro = name.includes("pro");
      const leveled = GeminiModel.isGemini3(name) && !pro && !image;
      switch (key) {
        case "inject_thought_signature":
        case "scrub_model_artifacts":
          return { found: true, value: true };
        case "signature_family":
          return { found: true, value: "gemini-flash" };
        case "system_instruction":
          return { found: true, value: GeminiModel.isGemini3(name) && !image };
        case "thinking_format":
          if (image) return { found: false, value: undefined };
          return { found: true, value: leveled ? "level" : "budget" };
        case "thinking_levels":
          return leveled
            ? { found: true, value: GEMINI_THINKING_LEVELS }
            : { found: false, value: undefined };
        case "thinking_budgets":
          if (image || leveled) return { found: false, value: undefined };
          return { found: true, value: pro ? GEMINI_PRO_BUDGETS : GEMINI_FLASH_BUDGETS };
        default:
          return { found: false, value: undefined };
      }
    }
    if (name.startsWith("claude-")) {
      if (CLAUDE_FLAGS.has(key)) return { found: true, value: true };
      if (key === "signature_family") return { found: true, value: "claude" };
    }
    return { found: false, value: undefined };
  }

  static normalizeTiered(registry: Registry, model: string): string {
    if (!registry.supportsProvider(model, "antigravity")) return model;
    return registry.upstream(model, "antigravity");
  }

  static configValue(registry: Registry, model: string, key: string): { found: boolean; value: unknown } {
    const cfg = registry.config(model, "antigravity");
    if (cfg) {
      if (key in cfg) return { found: true, value: cfg[key] };
      const custom = cfg.custom;
      if (custom && typeof custom === "object" && key in custom) {
        return { found: true, value: (custom as Json)[key] };
      }
    }
    return GeminiModel.familyConfig(model, key);
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
