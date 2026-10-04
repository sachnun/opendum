import { baseQuotaInfo, clampFraction, displayNumber, errorQuotaInfo, expiredQuotaInfo, parseQuotaNumber, parseQuotaRecord } from "../../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "../../types.js";
import { fetchJsonData, type Json } from "../common.js";

export const provider: QuotaProvider = {
  name: "openrouter",
  needsToken: false,
  fetch: (ctx, account, _token, forceRefresh) => fetchOpenRouterQuota(ctx, account, forceRefresh),
};

async function fetchOpenRouterQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.");
  }
  const key = await fetchJsonData(ctx, account, forceRefresh, "openrouter:key", "GET", "https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" }, null);
  const credits = await fetchJsonData(ctx, account, forceRefresh, "openrouter:credits", "GET", "https://openrouter.ai/api/v1/credits", { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" }, null);
  if (key.error && credits.error) return errorQuotaInfo(key.error);
  const keyData = parseQuotaRecord(key.data?.data) ?? {};
  const creditsData = parseQuotaRecord(credits.data?.data) ?? {};
  return baseQuotaInfo("success", openRouterGroups(keyData, creditsData));
}

function openRouterGroups(keyData: Json, creditsData: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const totalCredits = parseQuotaNumber(creditsData.total_credits);
  const totalUsage = parseQuotaNumber(creditsData.total_usage);
  if (totalCredits !== null && totalUsage !== null && totalCredits > 0) {
    const remaining = Math.max(0, totalCredits - totalUsage);
    const fraction = clampFraction(remaining / totalCredits);
    groups.push({
      name: "account-credits",
      displayName: "Account credits",
      remainingFraction: fraction,
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(totalCredits),
      usedRequests: displayNumber(totalCredits - remaining),
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `$${remaining.toFixed(2)} / $${totalCredits.toFixed(2)}`,
    });
  }
  const limit = parseQuotaNumber(keyData.limit);
  const remaining = parseQuotaNumber(keyData.limit_remaining);
  const hasKeyUsage = parseQuotaNumber(keyData.usage) !== null;
  if (limit !== null && remaining !== null && hasKeyUsage && limit > 0) {
    const fraction = clampFraction(remaining / limit);
    groups.push({
      name: "key-limit",
      displayName: "API key limit",
      remainingFraction: fraction,
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(limit),
      usedRequests: displayNumber(Math.max(0, limit - remaining)),
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `$${remaining.toFixed(2)} / $${limit.toFixed(2)}`,
    });
  }
  if (groups.length > 0) return groups;
  const usageDaily = parseQuotaNumber(keyData.usage_daily);
  if (usageDaily !== null) {
    return [{
      name: "daily-usage",
      displayName: "Today usage",
      remainingFraction: 1,
      remainingRequests: 1,
      maxRequests: 1,
      usedRequests: 0,
      resetTimeIso: null,
      resetInHuman: "resets daily",
      remainingLabel: `$${usageDaily.toFixed(2)}`,
    }];
  }
  const label = keyData.is_free_tier === true ? "free tier" : "active";
  return [{
    name: "key-status",
    displayName: "OpenRouter key",
    remainingFraction: 1,
    remainingRequests: 1,
    maxRequests: 1,
    usedRequests: 0,
    resetTimeIso: null,
    resetInHuman: null,
    remainingLabel: label,
  }];
}
