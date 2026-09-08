import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

const PERCH_ACCOUNT_URL = "https://app.perchai.app/api/perchai/account";

export async function fetchPerchQuota(
  _account: ProviderAccount,
  credentials?: string
): Promise<AccountQuotaInfo> {
  if (!credentials) {
    return {
      status: "expired",
      error: "No active Perch token available.",
      groups: [],
    };
  }

  try {
    const res = await fetch(PERCH_ACCOUNT_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.trim()}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      return {
        status: "error",
        error: `Perch returned HTTP ${res.status}`,
        groups: [],
      };
    }

    const data: any = await res.json();
    const planName = data?.session?.planName || "Starter";

    const groups: QuotaGroupDisplay[] = [
      {
        name: "starter-pool",
        displayName: `Perch (${planName})`,
        remainingFraction: 1,
        remainingRequests: 100,
        maxRequests: 100,
        usedRequests: 0,
        resetTimeIso: null,
        resetInHuman: null,
      },
    ];

    return {
      status: "success",
      groups,
    };
  } catch (err: any) {
    return {
      status: "error",
      error: err?.message || "Failed to fetch Perch quota",
      groups: [],
    };
  }
}
