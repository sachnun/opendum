import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

export async function fetchZenmuxQuota(
  account: ProviderAccount,
  _credentials?: string
): Promise<AccountQuotaInfo> {
  const platformKey = account.accountId?.trim();
  if (!platformKey) {
    return {
      status: "expired",
      error: "Platform key is required for ZenMux quota.",
      groups: [],
    };
  }

  try {
    const res = await fetch("https://zenmux.ai/api/v1/management/subscription/detail", {
      headers: {
        Authorization: `Bearer ${platformKey}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return {
        status: "error",
        error: `ZenMux subscription endpoint failed: HTTP ${res.status}`,
        groups: [],
      };
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const data = (payload.data || {}) as Record<string, unknown>;

    const windows = [
      { key: "quota_5_hour", display: "5-Hour Window" },
      { key: "quota_7_day", display: "7-Day Window" },
    ];

    const groups: QuotaGroupDisplay[] = [];

    for (const w of windows) {
      const win = data[w.key] as Record<string, unknown> | undefined;
      if (!win || typeof win !== "object") continue;

      const maxVal = Number(win.max_flows);
      const usedVal = Number(win.used_flows);
      const remainingVal = Number(win.remaining_flows);

      if (isNaN(maxVal) || isNaN(usedVal) || isNaN(remainingVal) || maxVal <= 0) continue;

      const fraction = Math.max(0, Math.min(1, remainingVal / maxVal));
      groups.push({
        name: w.key,
        displayName: w.display,
        remainingFraction: fraction,
        remainingRequests: remainingVal,
        maxRequests: maxVal,
        usedRequests: usedVal,
        resetTimeIso: null,
        resetInHuman: null,
      });
    }

    if (groups.length === 0) {
      groups.push({
        name: "zenmux-status",
        displayName: "ZenMux Active",
        remainingFraction: 1,
        remainingRequests: 1,
        maxRequests: 1,
        usedRequests: 0,
        resetTimeIso: null,
        resetInHuman: null,
      });
    }

    return {
      status: "success",
      groups,
    };
  } catch (err: unknown) {
    return {
      status: "error",
      error: err instanceof Error ? err.message : "Failed to fetch ZenMux quota",
      groups: [],
    };
  }
}
