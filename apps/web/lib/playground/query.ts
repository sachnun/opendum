import type { PlaygroundEndpoint, ReasoningEffort } from "~~/lib/playground/types";
import { parseJson } from "~~/lib/settle";

const ENDPOINTS: PlaygroundEndpoint[] = ["chat_completions", "messages", "responses"];
const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];

export class Query {
  static string(value: unknown): string | null {
    if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
    return typeof value === "string" ? value : null;
  }

  static endpoint(value: unknown): PlaygroundEndpoint | null {
    const endpoint = Query.string(value);
    return ENDPOINTS.includes(endpoint as PlaygroundEndpoint)
      ? (endpoint as PlaygroundEndpoint)
      : null;
  }

  static number(value: unknown): number | null {
    const raw = Query.string(value);
    if (raw === null || raw.trim() === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  static boolean(value: unknown): boolean | null {
    const raw = Query.string(value)?.trim().toLowerCase();
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  }

  static effort(value: unknown): ReasoningEffort | null {
    const effort = Query.string(value);
    return EFFORTS.includes(effort as ReasoningEffort) ? (effort as ReasoningEffort) : null;
  }

  static additional(value: unknown): string | null {
    const raw = Query.string(value);
    if (!raw?.trim()) return null;
    const parsed = parseJson(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? JSON.stringify(parsed, null, 2)
      : raw;
  }
}

export class Params {
  static parse(value: string): { params: Record<string, unknown> | null; error: string } {
    if (!value.trim()) return { params: null, error: "" };
    const parsed = parseJson(value) as unknown;
    if (parsed === null) return { params: null, error: "Invalid JSON." };
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { params: null, error: "Additional parameters must be a JSON object." };
    }
    return { params: parsed as Record<string, unknown>, error: "" };
  }

  static clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}

export class Ids {
  static short(): string {
    return Math.random().toString(36).slice(2, 9);
  }
}

export class Duration {
  static format(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
    if (value < 1000) return `${Math.round(value)} ms`;
    const seconds = value / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  }
}
