import { Result } from "effect";
import { Coerce, Safe } from "../helpers.js";

const RESTRICTION_CODES = new Set([11140, 11141, 11142, 17271, 17272, 17273, 17274, 17275, 17276]);
const RESTRICTION_COOLDOWN_MS = 30 * 60 * 1000;
const USAGE_LIMIT_CODE = 6004;
const REQUEST_FAULT_CODES = new Set([11128]);
const FALLBACK_MS = 5 * 60 * 1000;
const RESET_PATTERN = /reset at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC([+-]\d{1,2})/;

export class Workbuddy {
  static restrictionUntil(provider: string, body: string, now: Date): Date | null {
    if (provider !== "workbuddy") return null;
    const code = Workbuddy.codeOf(body);
    if (code === null || !RESTRICTION_CODES.has(code)) return null;
    return new Date(now.getTime() + RESTRICTION_COOLDOWN_MS);
  }

  static requestFault(provider: string, body: string): boolean {
    if (provider !== "workbuddy") return false;
    const code = Workbuddy.codeOf(body);
    return code !== null && REQUEST_FAULT_CODES.has(code);
  }

  static usageLimitReset(provider: string, body: string, now: Date): Date | null {
    if (provider !== "workbuddy" || Workbuddy.codeOf(body) !== USAGE_LIMIT_CODE) return null;
    const payload = Workbuddy.payloadOf(body) ?? {};
    const reset = Workbuddy.parseReset(
      `${Coerce.string(payload.msg)} ${Coerce.string(payload.message)}`
    );
    if (reset && reset.getTime() > now.getTime()) return reset;
    return new Date(now.getTime() + FALLBACK_MS);
  }

  private static codeOf(body: string): number | null {
    const code = Workbuddy.payloadOf(body)?.code;
    return typeof code === "number" ? code : null;
  }

  private static payloadOf(body: string): Record<string, unknown> | null {
    const parsed = Safe.json(body.trim());
    if (Result.isFailure(parsed)) return null;
    const payload = parsed.success;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload as Record<string, unknown>;
  }

  private static parseReset(text: string): Date | null {
    const match = RESET_PATTERN.exec(text);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, offset] = match;
    const offsetHours = Number.parseInt(offset, 10);
    if (!Number.isFinite(offsetHours)) return null;
    const utc = Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10)
    );
    const timestamp = utc - offsetHours * 60 * 60 * 1000;
    return Number.isFinite(timestamp) ? new Date(timestamp) : null;
  }
}

