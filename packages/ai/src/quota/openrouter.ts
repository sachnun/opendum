import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaGroupDisplay } from "./types.js";

export async function fetchOpenRouterQuota(
  _account: ProviderAccount,
  credentials?: string
): Promise<AccountQuotaInfo> {
  if (!credentials) {
    return {
      status: "expired",
      error: "No active OpenRouter API key available.",
      groups: [],
    };
  }

  const headers = {
    Authorization: `Bearer ${credentials.trim()}`,
    Accept: "application/json",
  };

  try {
    const [keyRes, creditsRes] = await Promise.all([
      fetch("https://openrouter.ai/api/v1/key", { headers }),
      fetch("https://openrouter.ai/api/v1/credits", { headers }),
    ]);

    const keyPayload = keyRes.ok ? ((await keyRes.json()) as Record<string, unknown>) : null;
    const creditsPayload = creditsRes.ok ? ((await creditsRes.json()) as Record<string, unknown>) : null;

    const keyData = (keyPayload?.data || {}) as Record<string, unknown>;
    const creditsData = (creditsPayload?.data || {}) as Record<string, unknown>;

    const groups: QuotaGroupDisplay[] = [];

    const totalCredits = Number(creditsData.total_credits);
    const totalUsage = Number(creditsData.total_usage);
    if (!isNaN(totalCredits) && !isNaN(totalUsage) && totalCredits > 0) {
      const remaining = Math.max(0, totalCredits - totalUsage);
      const fraction = Math.max(0, Math.min(1, remaining / totalCredits));
      groups.push({
        name: "account-credits",
        displayName: "Account credits",
        remainingFraction: fraction,
        remainingRequests: Math.round(remaining * 100) / 100,
        maxRequests: Math.round(totalCredits * 100) / 100,
        usedRequests: Math.round((totalCredits - remaining) * 100) / 100,
        resetTimeIso: null,
        resetInHuman: null,
      });
    }

    const limit = Number(keyData.limit);
    const limitRemaining = Number(keyData.limit_remaining);
    if (!isNaN(limit) && !isNaN(limitRemaining) && limit > 0) {
      const fraction = Math.max(0, Math.min(1, limitRemaining / limit));
      groups.push({
        name: "key-limit",
        displayName: "API key limit",
        remainingFraction: fraction,
        remainingRequests: Math.round(limitRemaining * 100) / 100,
        maxRequests: Math.round(limit * 100) / 100,
        usedRequests: Math.round((limit - limitRemaining) * 100) / 100,
        resetTimeIso: null,
        resetInHuman: null,
      });
    }

    if (groups.length === 0) {
      groups.push({
        name: "key-status",
        displayName: "OpenRouter key",
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
      error: err instanceof Error ? err.message : "Failed to fetch OpenRouter quota",
      groups: [],
    };
  }
}
