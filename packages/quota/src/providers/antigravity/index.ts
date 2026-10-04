import { getQuotaJson, putQuotaCache } from "../../cache.js";
import { baseQuotaInfo, clampFraction, displayNumber, errorQuotaInfo, formatTimeUntilResetIso, parseQuotaNumber, parseQuotaRecord, parseResetIso } from "../../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "../../types.js";
import type { Json } from "../common.js";

export const provider: QuotaProvider = {
  name: "antigravity",
  fetch: (ctx, account, token, forceRefresh) => fetchAntigravityQuota(ctx, account, token, forceRefresh),
};

async function fetchAntigravityQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const projectId = account.projectId?.trim() ?? "";
  if (!projectId) return errorQuotaInfo("Antigravity account is missing projectId. Re-authenticate this account.");
  const endpoints = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
  let lastErr = "";
  for (const endpoint of endpoints) {
    let result;
    try {
      result = await getQuotaJson(ctx, account, forceRefresh, "antigravity:fetchAvailableModels", "POST", `${endpoint}/v1internal:fetchAvailableModels`, {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/2.19.1 ${process.platform}/${process.arch}`,
      }, { project: projectId });
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      lastErr = `HTTP ${result.statusCode} ${result.raw}`;
      continue;
    }
    try {
      const payload = JSON.parse(result.raw) as Json;
      await putQuotaCache(ctx, result);
      return baseQuotaInfo("success", antigravityGroups(payload));
    } catch (error) {
      lastErr = error instanceof Error ? error.message : String(error);
      continue;
    }
  }
  return errorQuotaInfo(`Failed to fetch Antigravity quota data: ${lastErr}`);
}

function antigravityGroups(payload: Json): QuotaGroupDisplay[] {
  const models = parseQuotaRecord(payload.models) ?? {};

  const groups: Array<{ name: string; display: string; remainingFraction: number; resetIso: string | null }> = [
    { name: "claude", display: "Claude", remainingFraction: 1, resetIso: null },
    { name: "gemini", display: "Gemini", remainingFraction: 1, resetIso: null },
  ];

  for (const [modelId, entry] of Object.entries(models)) {
    const group = modelId.startsWith("gemini") ? groups[1] : groups[0];
    const modelRecord = parseQuotaRecord(entry);
    if (!modelRecord) continue;
    const quotaInfo = parseQuotaRecord(modelRecord.quotaInfo);
    if (!quotaInfo) continue;

    const value = quotaInfo.remainingFraction === undefined || quotaInfo.remainingFraction === null
      ? null
      : parseQuotaNumber(quotaInfo.remainingFraction);
    const fraction = value === null ? 0 : clampFraction(value);
    if (fraction < group.remainingFraction) group.remainingFraction = fraction;

    const iso = parseResetIso(quotaInfo.resetTime);
    if (iso && (!group.resetIso || iso < group.resetIso)) group.resetIso = iso;
  }

  return groups.map((group) => ({
    name: group.name,
    displayName: group.display,
    remainingFraction: group.remainingFraction,
    remainingRequests: displayNumber(group.remainingFraction * 100),
    maxRequests: 100,
    usedRequests: displayNumber(100 - group.remainingFraction * 100),
    resetTimeIso: group.resetIso,
    resetInHuman: formatTimeUntilResetIso(group.resetIso),
  }));
}
