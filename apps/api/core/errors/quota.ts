import { Result } from "effect";
import { Coerce, Safe } from "../helpers.js";

export class ProviderQuota {
  static antigravityExhausted(provider: string, status: number, body: string): boolean {
    if (provider !== "antigravity" || status !== 429) return false;
    const parsed = Safe.json(body.trim());
    if (Result.isFailure(parsed)) return false;
    const payload = parsed.success;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    const error = (payload as Record<string, unknown>).error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
    return Coerce.string((error as Record<string, unknown>).status).toLowerCase() === "resource_exhausted";
  }

  static codexDisabledUntil(provider: string, status: number, body: string, now: Date): Date | null {
    if (provider !== "codex" || status !== 429) return null;
    const parsed = Safe.json(body.trim());
    if (Result.isFailure(parsed)) return null;
    const payload = parsed.success;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const error = (payload as Record<string, unknown>).error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
    const record = error as Record<string, unknown>;
    if (Coerce.string(record.type).trim() !== "usage_limit_reached") return null;
    const resetsAt = ProviderQuota.int64(record.resets_at);
    if (resetsAt !== null) {
      const until = new Date(resetsAt * 1000);
      if (until.getTime() > now.getTime()) return until;
    }
    const resetsIn = ProviderQuota.int64(record.resets_in_seconds);
    if (resetsIn !== null && resetsIn > 0) return new Date(now.getTime() + resetsIn * 1000);
    return null;
  }

  private static int64(value: unknown): number | null {
    if (typeof value === "number" && value > 0) return Math.trunc(value);
    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value.trim(), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return null;
  }
}

