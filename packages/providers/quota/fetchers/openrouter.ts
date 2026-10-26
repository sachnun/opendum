import { Effect } from "effect";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  expiredInfo,
  parseNumber,
  parseRecord,
} from "../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "../types.js";
import { jsonData, type Json } from "./shared.js";

export function openrouterQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return Effect.succeed(
      expiredInfo("API key is missing or invalid. Please reconnect this account.")
    );
  }
  const headers = { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };
  return Effect.all(
    [
      jsonData(ctx, account, forceRefresh, "openrouter:key", "GET", "https://openrouter.ai/api/v1/key", headers, null),
      jsonData(ctx, account, forceRefresh, "openrouter:credits", "GET", "https://openrouter.ai/api/v1/credits", headers, null),
    ],
    { concurrency: 2 }
  ).pipe(
    Effect.map(([key, credits]) => {
      if (key.error && credits.error) return errorInfo(key.error);
      const keyData = parseRecord(key.data?.data) ?? {};
      const creditsData = parseRecord(credits.data?.data) ?? {};
      return baseInfo("success", quotaGroups(keyData, creditsData));
    })
  );
}

function quotaGroups(keyData: Json, creditsData: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const totalCredits = parseNumber(creditsData.total_credits);
  const totalUsage = parseNumber(creditsData.total_usage);
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
  const limit = parseNumber(keyData.limit);
  const remaining = parseNumber(keyData.limit_remaining);
  const hasKeyUsage = parseNumber(keyData.usage) !== null;
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
  const usageDaily = parseNumber(keyData.usage_daily);
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
