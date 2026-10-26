import type { PlaygroundEndpoint, ReasoningEffort } from "./types";

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
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? JSON.stringify(parsed, null, 2)
        : null;
    } catch {
      return raw;
    }
  }
}

export class Params {
  static parse(value: string): { params: Record<string, unknown> | null; error: string } {
    if (!value.trim()) return { params: null, error: "" };
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { params: null, error: "Additional parameters must be a JSON object." };
      }
      return { params: parsed as Record<string, unknown>, error: "" };
    } catch (error) {
      return { params: null, error: error instanceof Error ? error.message : "Invalid JSON." };
    }
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
