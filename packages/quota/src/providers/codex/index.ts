import { getQuotaJson, putQuotaCache } from "#quota/lib/cache.ts";
import { baseQuotaInfo, errorQuotaInfo, formatTimeUntilReset, parseQuotaNumber, parseQuotaRecord, parseQuotaString } from "#quota/lib/helpers.ts";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "#quota/types.ts";
import { quotaFallbackTier, type Json } from "#quota/providers/common.ts";

export const provider: QuotaProvider = {
  name: "codex",
  fetch: (ctx, account, token, forceRefresh) => fetchCodexQuota(ctx, account, token, forceRefresh),
};

async function fetchCodexQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const fallbackTier = quotaFallbackTier(account);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": `opencode/1.14.28 (${process.platform} ${process.platform}; ${process.arch})`,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    originator: "opencode",
  };
  const accountId = account.accountId?.trim() || extractAccountIdFromJwt(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  let result;
  try {
    result = await getQuotaJson(ctx, account, forceRefresh, "codex:usage", "GET", "https://chatgpt.com/backend-api/wham/usage", headers, null);
  } catch (error) {
    return errorQuotaInfo(error instanceof Error ? error.message : String(error));
  }
  const headerGroups = parseCodexHeaderGroups(result.header, fallbackTier);
  if (result.statusCode < 200 || result.statusCode >= 300) {
    if (headerGroups.length > 0) return baseQuotaInfo("success", headerGroups);
    return errorQuotaInfo(`Codex quota endpoint failed: HTTP ${result.statusCode} ${result.raw}`);
  }
  let payload: Json;
  try {
    payload = JSON.parse(result.raw) as Json;
  } catch {
    payload = {};
  }
  const tier = parseQuotaString(payload.plan_type) || fallbackTier;
  const apiGroups = parseCodexApiGroups(payload, tier);
  if (apiGroups.length > 0) {
    await putQuotaCache(ctx, result);
    return baseQuotaInfo("success", apiGroups);
  }
  if (headerGroups.length > 0) {
    await putQuotaCache(ctx, result);
    return baseQuotaInfo("success", headerGroups);
  }
  return errorQuotaInfo("Codex quota payload did not include usable quota data");
}

function extractAccountIdFromJwt(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1].trim()) return "";
  let claims: Json;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Json;
  } catch {
    return "";
  }
  const authClaims = parseQuotaRecord(claims["https://api.openai.com/auth"]);
  if (authClaims) {
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = parseQuotaString(authClaims[key]);
      if (value) return value;
    }
  }
  for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
    const value = parseQuotaString(claims[key]);
    if (value) return value;
  }
  return "";
}

function parseCodexApiGroups(payload: Json, tier: string): QuotaGroupDisplay[] {
  const rateLimit = parseQuotaRecord(payload.rate_limit) ?? {};
  return codexWindowGroups(
    parseQuotaRecord(rateLimit.primary_window) ?? {},
    parseQuotaRecord(rateLimit.secondary_window) ?? {},
    tier,
    true
  );
}

function parseCodexHeaderGroups(headers: Headers, tier: string): QuotaGroupDisplay[] {
  const primary: Json = {
    used_percent: headers.get("x-codex-primary-used-percent") ?? "",
    limit_window_minutes: headers.get("x-codex-primary-window-minutes") ?? "",
    reset_at: headers.get("x-codex-primary-reset-at") ?? "",
  };
  const secondary: Json = {
    used_percent: headers.get("x-codex-secondary-used-percent") ?? "",
    limit_window_minutes: headers.get("x-codex-secondary-window-minutes") ?? "",
    reset_at: headers.get("x-codex-secondary-reset-at") ?? "",
  };
  return codexWindowGroups(primary, secondary, tier, false);
}

function codexWindowGroups(primary: Json, secondary: Json, tier: string, apiNames: boolean): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const first = codexWindowGroup("primary", primary, tier, apiNames);
  if (first) groups.push(first);
  const second = codexWindowGroup("secondary", secondary, tier, apiNames);
  if (second) groups.push(second);
  return groups;
}

function codexWindowGroup(name: string, record: Json, tier: string, apiNames: boolean): QuotaGroupDisplay | null {
  const used = parseQuotaNumber(record.used_percent);
  if (used === null) return null;
  void tier;
  let windowMinutes = parseQuotaNumber(record.window_minutes) ?? 0;
  if (!apiNames) {
    windowMinutes = parseQuotaNumber(record.limit_window_minutes) ?? 0;
  } else if (windowMinutes === 0) {
    const seconds = parseQuotaNumber(record.limit_window_seconds) ?? 0;
    windowMinutes = Math.ceil(seconds / 60);
  }
  const resetAt = parseQuotaNumber(record.reset_at) ?? 0;
  let resetTimestamp = 0;
  if (resetAt > 10_000_000_000) resetTimestamp = Math.trunc(resetAt);
  else if (resetAt > 0) resetTimestamp = Math.trunc(resetAt * 1000);
  const remainingPercent = Math.max(0, 100 - used);
  let display = "Usage";
  if (name === "secondary") display = "Weekly usage";
  else if (windowMinutes > 0) display = codexWindowDisplayName(windowMinutes);
  const resetIso = resetTimestamp > 0 ? new Date(resetTimestamp).toISOString() : null;
  return {
    name,
    displayName: display,
    remainingFraction: remainingPercent / 100,
    remainingRequests: Math.round(remainingPercent),
    maxRequests: 100,
    usedRequests: 100 - Math.round(remainingPercent),
    resetTimeIso: resetIso,
    resetInHuman: formatTimeUntilReset(resetTimestamp),
  };
}

function codexWindowDisplayName(windowMinutes: number): string {
  const rounded = Math.round(windowMinutes);
  if (rounded === 300) return "5 hour usage";
  if (rounded > 0 && rounded % 1440 === 0) return `${rounded / 1440}d usage`;
  if (rounded > 0 && rounded % 60 === 0) return `${rounded / 60} hour usage`;
  return `${Math.round(windowMinutes)}m usage`;
}
