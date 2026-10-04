import { baseQuotaInfo, clampFraction, displayNumber, errorQuotaInfo, expiredQuotaInfo, formatFloat, formatTimeUntilResetIso, parseQuotaNumber, parseQuotaRecord, parseQuotaString, parseResetIso } from "#quota/lib/helpers.ts";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "#quota/types.ts";
import { fetchJsonData, type Json } from "#quota/providers/common.ts";

export const provider: QuotaProvider = {
  name: "zenmux",
  fetch: (ctx, account, _token, forceRefresh) => fetchZenmuxQuota(ctx, account, forceRefresh),
};

async function fetchZenmuxQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const platformKey = account.accountId?.trim() ?? "";
  if (!platformKey) return expiredQuotaInfo("Platform key is required for ZenMux quota.");
  const { data, error } = await fetchJsonData(
    ctx, account, forceRefresh, "zenmux:subscription", "GET",
    "https://zenmux.ai/api/v1/management/subscription/detail",
    { Authorization: `Bearer ${platformKey}`, Accept: "application/json" }, null
  );
  if (error || !data) return errorQuotaInfo(`ZenMux subscription endpoint failed: ${error ?? "unknown error"}`);
  const record = parseQuotaRecord(data.data);
  if (!record) return errorQuotaInfo("ZenMux subscription response did not include data");
  return baseQuotaInfo("success", zenmuxGroups(record));
}

function zenmuxGroups(data: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const windows = [
    { key: "quota_5_hour", display: "5-Hour Window" },
    { key: "quota_7_day", display: "7-Day Window" },
  ];
  for (const window of windows) {
    const win = parseQuotaRecord(data[window.key]);
    if (!win) continue;
    const maxVal = parseQuotaNumber(win.max_flows);
    const usedVal = parseQuotaNumber(win.used_flows);
    const remainingVal = parseQuotaNumber(win.remaining_flows);
    if (maxVal === null || usedVal === null || remainingVal === null || maxVal <= 0) continue;
    const fraction = clampFraction(remainingVal / maxVal);
    const resetRaw = parseQuotaString(win.resets_at);
    const resetIso = resetRaw ? parseResetIso(resetRaw) : null;
    groups.push({
      name: window.key,
      displayName: window.display,
      remainingFraction: fraction,
      remainingRequests: displayNumber(remainingVal),
      maxRequests: displayNumber(maxVal),
      usedRequests: displayNumber(usedVal),
      resetTimeIso: resetIso,
      resetInHuman: formatTimeUntilResetIso(resetIso),
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
