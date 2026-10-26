import { Effect, Result } from "effect";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  expiredInfo,
  parseNumber,
  parseRecord,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";

export function openrouterQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const decrypted = Result.try({
    try: () => ctx.decrypt(account.accessToken ?? ""),
    catch: () => null,
  });
  if (Result.isFailure(decrypted)) {
    return Effect.succeed(
      expiredInfo("API key is missing or invalid. Please reconnect this account.")
    );
  }
  const apiKey = decrypted.success;
  const headers = { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" };
  return Effect.all(
    [
      quotaPayload(ctx, account, forceRefresh, {
        cache: "openrouter:key",
        method: "GET",
        url: "https://openrouter.ai/api/v1/key",
        headers,
        label: "OpenRouter key",
      }),
      quotaPayload(ctx, account, forceRefresh, {
        cache: "openrouter:credits",
        method: "GET",
        url: "https://openrouter.ai/api/v1/credits",
        headers,
        label: "OpenRouter credits",
      }),
    ],
    { concurrency: 2 }
  ).pipe(
    Effect.map(([key, credits]) => {
      if (!key.ok && !credits.ok) return key.info;
      const keyData = key.ok ? (parseRecord(key.data.data) ?? {}) : {};
      const creditsData = credits.ok ? (parseRecord(credits.data.data) ?? {}) : {};
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
