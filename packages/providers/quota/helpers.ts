import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

export function clampFraction(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function displayNumber(value: number): number {
  if (Math.abs(value - Math.round(value)) < 0.001) return Math.round(value);
  return Math.round(value * 100) / 100;
}

export function formatFloat(value: number): string {
  if (Math.abs(value - Math.round(value)) < 0.001) return Math.round(value).toFixed(0);
  return value.toFixed(2);
}

export function resetText(resetTimestamp: number): string | null {
  if (resetTimestamp <= 0) return null;
  const diff = resetTimestamp - Date.now();
  if (diff <= 0) return "resetting...";
  const hours = Math.floor(diff / (60 * 60 * 1000));
  const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function resetIso(resetIso: string | null | undefined): string | null {
  if (!resetIso || !resetIso.trim()) return null;
  const parsed = Date.parse(resetIso);
  if (!Number.isFinite(parsed)) return null;
  return resetText(parsed);
}

export function isoOf(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return null;
  }
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const seconds = parseNumber((value as Record<string, unknown>).seconds);
    if (seconds !== null) return new Date(Math.trunc(seconds * 1000)).toISOString();
  }
  return null;
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

export function parseArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function baseInfo(
  status: string,
  groups: QuotaGroupDisplay[],
  message = ""
): AccountQuotaInfo {
  return { status, error: message, groups };
}

export function expiredInfo(message: string): AccountQuotaInfo {
  return baseInfo("expired", [], message);
}

export function errorInfo(message: string): AccountQuotaInfo {
  return baseInfo("error", [], message);
}

export function firstValue(...values: string[]): string {
  for (const value of values) {
    if (value.trim()) return value.trim();
  }
  return "";
}
