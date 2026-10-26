import { formatDistanceToNowStrict } from "date-fns";

import type { ProviderDetailData } from "./api-types";
import { statusTag, stripStatus, type ErrorStatusTag } from "./account-errors";

export type StatDeltaTone = "positive" | "negative" | "neutral";

export type StatMetric = { key: string; label: string; value: string; numericValue: number; formatDelta: (delta: number) => string; getTone?: (delta: number) => StatDeltaTone };

export type DurationPoint = { time: string; avgDuration: number | null };

export type ErrorPreviewEntry = {
  id: string;
  model: string | null;
  errorCode: number | null;
  errorMessage: string;
  createdAt: string | Date | null;
};

export type Account = ProviderDetailData["accounts"][number];

export function formatDuration(duration: number | null): string {
  if (duration === null) return "-";
  if (duration >= 1000) return `${(duration / 1000).toFixed(2)}s`;
  return `${duration}ms`;
}

export function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString();
}

export function signedInteger(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${compactNumber(Math.abs(Math.round(delta)))}`;
}

export function signedDuration(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  return `${sign} ${formatDuration(Math.abs(Math.round(delta)))}`;
}

export function signedPercent(delta: number): string {
  const sign = delta > 0 ? "+" : "-";
  const value = Math.round(Math.abs(delta) * 10) / 10;
  return `${sign} ${value}%`;
}

export function statValues(items: StatMetric[]): Record<string, number> {
  const values: Record<string, number> = {};

  for (const item of items) {
    if (Number.isFinite(item.numericValue)) values[item.key] = item.numericValue;
  }

  return values;
}

export function hourKeys(hours: number): string[] {
  const now = new Date();
  const currentHourUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));

  return Array.from({ length: hours }, (_, index) => {
    const date = new Date(currentHourUtc);
    date.setUTCHours(currentHourUtc.getUTCHours() - (hours - 1 - index));
    return date.toISOString();
  });
}

export function dayKeys(days: number): string[] {
  const now = new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  return Array.from({ length: days }, (_, index) => {
    const date = new Date(todayUtc);
    date.setUTCDate(todayUtc.getUTCDate() - (days - 1 - index));
    return date.toISOString().split("T")[0] ?? "";
  });
}

export function dailyPoints(points: Array<{ date: string; count: number }>) {
  const valuesByDate = new Map(points.map((point) => [point.date, point.count]));
  return dayKeys(30).map((date) => ({ date, count: valuesByDate.get(date) ?? 0 }));
}

export function durationPoints(points: Array<{ time: string; avgDuration: number }>): DurationPoint[] {
  const valuesByTime = new Map(points.map((point) => [point.time, point.avgDuration]));
  return hourKeys(24).map((time) => ({ time, avgDuration: valuesByTime.get(time) ?? null }));
}

export function relativeTime(value: string | Date | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const relative = formatDistanceToNowStrict(date, { addSuffix: true });
  return relative === "0 seconds ago" ? "just now" : relative;
}

export function timeOf(value: string | Date | null | undefined): number | null {
  if (!value) return null;

  const timeMs = new Date(value).getTime();
  return Number.isNaN(timeMs) ? null : timeMs;
}

export function hourLabel(time: string): string {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? time.slice(11, 16) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function prevDay(time: string): boolean {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

export function paidTier(tier: string, provider?: string): boolean {
  const value = tier.trim().toLowerCase();
  if (provider === "antigravity") return ["paid", "standard-tier"].includes(value) || value.startsWith("g1-");
  if (provider === "kiro") return ["pro", "pro-plus", "pro+", "power"].includes(value);
  return ["paid", "standard-tier", "plus", "pro", "pro-plus", "pro+", "prolite", "power", "team", "go", "self_serve_business_usage_based", "business", "enterprise_cbp_usage_based", "enterprise", "student", "edu", "education", "hc"].includes(value);
}

export function freeTier(tier: string): boolean {
  return ["free", "free-tier", "legacy-tier"].includes(tier.trim().toLowerCase());
}

export function tierLabel(tier: string, provider?: string): "Paid" | "Free" | "" {
  if (paidTier(tier, provider)) return "Paid";
  if (freeTier(tier)) return "Free";
  return "";
}

export function maskText(value: string): string {
  return value.replace(/\S/g, "•");
}

export function accountHeader(account: Account): { title: string; subtitle: string | null } {
  const rawName = account.name.trim();
  const rawEmail = account.email?.trim() ?? "";

  if (!rawEmail) return { title: rawName, subtitle: null };

  const normalizedEmail = rawEmail.toLowerCase();
  let title = rawName;
  const trailingEmailMatch = title.match(/\(([^)]+)\)\s*$/);
  if (trailingEmailMatch?.[1]?.trim().toLowerCase() === normalizedEmail) {
    title = title.replace(/\([^)]+\)\s*$/, "").trim();
  }

  if (!title) title = rawEmail;
  if (title.toLowerCase().includes(normalizedEmail)) return { title, subtitle: null };
  return { title, subtitle: rawEmail };
}

export function dateTime(value: Date): string {
  return value.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function errorTime(entry: ErrorPreviewEntry): string {
  if (!entry.createdAt) return "Unknown time";
  const createdAt = new Date(entry.createdAt);
  return Number.isNaN(createdAt.getTime()) ? "Unknown time" : relativeTime(createdAt);
}

export function errorPreview(entry: ErrorPreviewEntry, maxLength = 150): string {
  const message = stripStatus(entry.errorMessage, entry.errorCode);
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

export function errorStatus(entry: ErrorPreviewEntry): ErrorStatusTag | null {
  return statusTag(entry.errorCode);
}
