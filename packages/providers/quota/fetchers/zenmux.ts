import { Effect } from "effect";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  expiredInfo,
  formatFloat,
  resetIso,
  parseNumber,
  parseRecord,
  parseString,
  isoOf,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";

export function zenmuxQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const platformKey = account.accountId?.trim() ?? "";
  if (!platformKey) {
    return Effect.succeed(expiredInfo("Platform key is required for ZenMux quota."));
  }
  return quotaPayload(ctx, account, forceRefresh, {
    cache: "zenmux:subscription",
    method: "GET",
    url: "https://zenmux.ai/api/v1/management/subscription/detail",
    headers: { Authorization: `Bearer ${platformKey}`, Accept: "application/json" },
    label: "ZenMux subscription",
  }).pipe(
    Effect.map((payload) => {
      if (!payload.ok) return payload.info;
      const record = parseRecord(payload.data.data);
      if (!record) return errorInfo("ZenMux subscription response did not include data");
      return baseInfo("success", zenmuxGroups(record));
    })
  );
}

function zenmuxGroups(data: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const windows = [
    { key: "quota_5_hour", display: "5-Hour Window" },
    { key: "quota_7_day", display: "7-Day Window" },
  ];
  for (const window of windows) {
    const win = parseRecord(data[window.key]);
    if (!win) continue;
    const maxVal = parseNumber(win.max_flows);
    const usedVal = parseNumber(win.used_flows);
    const remainingVal = parseNumber(win.remaining_flows);
    if (maxVal === null || usedVal === null || remainingVal === null || maxVal <= 0) continue;
    const fraction = clampFraction(remainingVal / maxVal);
    const resetRaw = parseString(win.resets_at);
    const resetValue = resetRaw ? isoOf(resetRaw) : null;
    groups.push({
      name: window.key,
      displayName: window.display,
      remainingFraction: fraction,
      remainingRequests: displayNumber(remainingVal),
      maxRequests: displayNumber(maxVal),
      usedRequests: displayNumber(usedVal),
      resetTimeIso: resetValue,
      resetInHuman: resetIso(resetValue),
      remainingLabel: `${formatFloat(remainingVal)} / ${formatFloat(maxVal)} flows`,
    });
  }
  if (groups.length === 0) {
    return [{
      name: "account-status",
      displayName: "Account status",
      remainingFraction: 1,
      remainingRequests: 1,
      maxRequests: 1,
      usedRequests: 0,
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: "active",
    }];
  }
  return groups;
}
