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
  resetIso,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";
import { API_BASE_URL, API_KEY_HEADER, THEOS_PATH } from "@opendum/providers/auth/deepai/constants";

export function deepaiQuota(
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
    cache: "deepai:theos",
    method: "GET",
    url: `${API_BASE_URL}${THEOS_PATH}`,
    headers: { [API_KEY_HEADER]: apiKey, Accept: "application/json" },
    label: "DeepAI allowance",
    expiredMessage: "DeepAI API key is invalid or expired. Please reconnect this account.",
  }).pipe(
    Effect.map((payload) => {
      if (!payload.ok) return payload.info;
      const groups = deepaiGroups(payload.data);
      return groups.length > 0 ? baseInfo("success", groups) : errorInfo("DeepAI allowance response did not include a balance");
    })
  );
}

function deepaiGroups(payload: Json): QuotaGroupDisplay[] {
  if (payload.enabled === false) return [];
  const groups: QuotaGroupDisplay[] = [];
  const balance = parseNumber(payload.balance);
  const granted = parseNumber(payload.granted);
  if (balance !== null && granted !== null && granted > 0) {
    const remaining = Math.max(0, balance);
    const reset = isoOf(payload.refresh_at);
    groups.push({
      name: "theos-balance",
      displayName: "Theos balance",
      remainingFraction: clampFraction(remaining / granted),
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(granted),
      usedRequests: displayNumber(Math.max(0, granted - remaining)),
      resetTimeIso: reset,
      resetInHuman: resetIso(reset),
      remainingLabel: `${formatFloat(remaining)} / ${formatFloat(granted)} Theos`,
    });
  }
  const lane = parseNumber(payload.lane_version);
  if (lane !== null) {
    groups.push({
      name: "lane",
      displayName: "Lane",
      remainingFraction: 1,
      remainingRequests: 1,
      maxRequests: 1,
      usedRequests: 0,
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `v${formatFloat(lane)}`,
    });
  }
  return groups;
}
