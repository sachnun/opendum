import type { QuotaGroupDisplay } from "./api-types";

export function quotaPercentRemaining(group: QuotaGroupDisplay): number {
  return Math.max(0, Math.min(100, Math.round(group.remainingFraction * 100)));
}

export function quotaResetTitle(group: QuotaGroupDisplay): string | undefined {
  if (!group.resetTimeIso) return undefined;
  const resetDate = new Date(group.resetTimeIso);
  return Number.isNaN(resetDate.getTime()) ? undefined : resetDate.toLocaleString();
}
