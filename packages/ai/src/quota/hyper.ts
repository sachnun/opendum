import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

export async function fetchHyperQuota(
  _account: ProviderAccount,
  credentials?: string
): Promise<AccountQuotaInfo> {
  if (!credentials) {
    return {
      status: "expired",
      error: "No active Hyper API key available.",
      groups: [],
    };
  }

  try {
    const res = await fetch("https://hyper.charm.land/v1/credits", {
      headers: {
        Authorization: `Bearer ${credentials.trim()}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return {
        status: "error",
        error: `Hyper credits endpoint failed: HTTP ${res.status}`,
        groups: [],
      };
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const balance = Number(payload.balance);

    const groups: QuotaGroupDisplay[] = [];

    if (!isNaN(balance)) {
      const usd = Math.round(balance * 0.05 * 100) / 100;
      groups.push({
        name: "account-balance",
        displayName: "Balance (USD)",
        remainingFraction: balance > 0 ? 1 : 0,
        remainingRequests: usd,
        maxRequests: usd,
        usedRequests: 0,
        resetTimeIso: null,
        resetInHuman: null,
      });
    } else {
      groups.push({
        name: "account-balance",
        displayName: "Hyper Active",
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
      error: err instanceof Error ? err.message : "Failed to fetch Hyper quota",
      groups: [],
    };
  }
}
