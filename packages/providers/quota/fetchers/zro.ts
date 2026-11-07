import { Effect, Result } from "effect";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  expiredInfo,
  formatFloat,
  isoOf,
  parseNumber,
  parseRecord,
  parseString,
  resetIso,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";

const STATUS_URL = "https://zro.moonmath.ai/api/cli/status";

export function zroQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const decrypted = Result.try({
    try: () => ctx.decrypt(account.accessToken ?? ""),
    catch: () => null,
  });
  if (Result.isFailure(decrypted)) {
    return Effect.succeed(expiredInfo("API key is missing or invalid. Please reconnect this account."));
  }
  const apiKey = decrypted.success.trim();
  if (!apiKey) {
    return Effect.succeed(expiredInfo("API key is missing or invalid. Please reconnect this account."));
  }
  return quotaPayload(ctx, account, forceRefresh, {
    cache: "zro:status",
    method: "GET",
    url: STATUS_URL,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    label: "Zro usage",
    expiredMessage: "Zro API key is invalid or expired. Please reconnect this account.",
  }).pipe(
    Effect.map((payload) => {
      if (!payload.ok) return payload.info;
      const groups = zroGroups(payload.data);
      return groups.length > 0 ? baseInfo("success", groups) : errorInfo("Zro status response did not include usage data");
    })
  );
}

function zroGroups(payload: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const billing = parseRecord(payload.billing) ?? {};
  const free = parseRecord(billing.free);
  if (free) {
    const percent = parseNumber(free.remainingPercent);
    if (percent !== null) {
      const fraction = clampFraction(percent / 100);
      const reset = isoOf(free.resetsAt);
      groups.push({
        name: "free-daily",
        displayName: "Free daily usage",
        remainingFraction: fraction,
        remainingRequests: displayNumber(percent),
        maxRequests: 100,
        usedRequests: displayNumber(100 - percent),
        resetTimeIso: reset,
        resetInHuman: resetIso(reset),
        remainingLabel: `${formatFloat(percent)}% left`,
      });
    }
  }

  const packs = parseRecord(billing.usagePacks);
  const remaining = parseNumber(packs?.remaining);
  if (remaining !== null && remaining > 0) {
    const total = parseNumber(packs?.total) ?? 0;
    groups.push({
      name: "usage-packs",
      displayName: "Usage packs",
      remainingFraction: clampFraction(remaining / total),
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(total),
      usedRequests: displayNumber(parseNumber(packs?.used) ?? 0),
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `$${formatFloat(remaining)} remaining`,
    });
  }

  const plan = parseString(billing.plan);
  if (plan) {
    groups.push({
      name: "plan",
      displayName: "Plan",
      remainingFraction: 1,
      remainingRequests: 1,
      maxRequests: 1,
      usedRequests: 0,
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: plan,
    });
  }

  return groups;
}
