import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

const QUOTA_MAX_REQUESTS: Record<string, Record<string, number>> = {
  "standard-tier": {
    "claude-opus-4-6": 150,
    "claude-sonnet-4-6": 150,
    "gemini-3.1-pro-preview": 320,
    "gemini-3-flash-preview": 400,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
  "free-tier": {
    "claude-opus-4-6": 50,
    "claude-sonnet-4-6": 50,
    "gemini-3.1-pro-preview": 150,
    "gemini-3-flash-preview": 500,
    "gemini-2.5-flash": 3000,
    "gemini-2.5-flash-lite": 5000,
  },
};

export async function fetchAntigravityQuota(
  account: ProviderAccount,
  credentials?: string
): Promise<AccountQuotaInfo> {
  if (!credentials) {
    return {
      status: "expired",
      error: "No active access token available.",
      groups: [],
    };
  }

  const tier = account.tier || "free-tier";
  const limits = QUOTA_MAX_REQUESTS[tier] || QUOTA_MAX_REQUESTS["free-tier"]!;

  const groups: QuotaGroupDisplay[] = Object.entries(limits).map(([model, maxRequests]) => {
    return {
      name: model,
      displayName: model,
      remainingFraction: 1,
      remainingRequests: maxRequests,
      maxRequests,
      usedRequests: 0,
      resetTimeIso: null,
      resetInHuman: null,
    };
  });

  return {
    status: "success",
    groups,
  };
}
