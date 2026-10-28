import { Effect } from "effect";
import { baseInfo, errorInfo, resetText, parseNumber, parseRecord, parseString } from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { Jwt } from "@opendum/providers/core/identity";
import { quotaPayload, fallbackTier, type Json } from "@opendum/providers/quota/fetchers/shared";

export function codexQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const defaultTier = fallbackTier(account);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": `opencode/1.19.5 (${process.platform} ${process.platform}; ${process.arch})`,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    originator: "opencode",
  };
  const accountId = account.accountId?.trim() || jwtAccount(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  return quotaPayload(ctx, account, forceRefresh, {
    cache: "codex:usage",
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    headers,
    label: "Codex",
  }).pipe(
    Effect.map((payload) => {
      if (!payload.ok) {
        const fallbackHeaders = payload.result ? headerGroups(payload.result.header, defaultTier) : [];
        return fallbackHeaders.length > 0 ? baseInfo("success", fallbackHeaders) : payload.info;
      }
      const headerResult = headerGroups(payload.result.header, defaultTier);
      const tier = parseString(payload.data.plan_type) || defaultTier;
      const apiResult = apiGroups(payload.data, tier);
      const groups = apiResult.length > 0 ? apiResult : headerResult;
      if (groups.length === 0) {
        return errorInfo("Codex quota payload did not include usable quota data");
      }
      return baseInfo("success", groups);
    })
  );
}

function jwtAccount(token: string): string {
  const claims = Jwt.claims(token);
  if (!claims) return "";
  for (const source of [Jwt.nested(claims, "https://api.openai.com/auth"), claims]) {
    if (!source) continue;
    const value = Jwt.first(source, ["chatgpt_workspace_id", "workspace_id", "organization_id"]);
    if (value) return value;
  }
  return "";
}

function apiGroups(payload: Json, tier: string): QuotaGroupDisplay[] {
  const rateLimit = parseRecord(payload.rate_limit) ?? {};
  return windowGroups(
    parseRecord(rateLimit.primary_window) ?? {},
    parseRecord(rateLimit.secondary_window) ?? {},
    tier,
    true
  );
}

function headerGroups(headers: Headers, tier: string): QuotaGroupDisplay[] {
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
  return windowGroups(primary, secondary, tier, false);
}

function windowGroups(primary: Json, secondary: Json, tier: string, apiNames: boolean): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const first = windowGroup("primary", primary, tier, apiNames);
  if (first) groups.push(first);
  const second = windowGroup("secondary", secondary, tier, apiNames);
  if (second) groups.push(second);
  return groups;
}

function windowGroup(name: string, record: Json, tier: string, apiNames: boolean): QuotaGroupDisplay | null {
  const used = parseNumber(record.used_percent);
  if (used === null) return null;
  void tier;
  let windowMinutes = parseNumber(record.window_minutes) ?? 0;
  if (!apiNames) {
    windowMinutes = parseNumber(record.limit_window_minutes) ?? 0;
  } else if (windowMinutes === 0) {
    const seconds = parseNumber(record.limit_window_seconds) ?? 0;
    windowMinutes = Math.ceil(seconds / 60);
  }
  const resetAt = parseNumber(record.reset_at) ?? 0;
  let resetTimestamp = 0;
  if (resetAt > 10_000_000_000) resetTimestamp = Math.trunc(resetAt);
  else if (resetAt > 0) resetTimestamp = Math.trunc(resetAt * 1000);
  const remainingPercent = Math.max(0, 100 - used);
  let display = "Usage";
  if (name === "secondary") display = "Weekly usage";
  else if (windowMinutes > 0) display = windowLabel(windowMinutes);
  const resetIso = resetTimestamp > 0 ? new Date(resetTimestamp).toISOString() : null;
  return {
    name,
    displayName: display,
    remainingFraction: remainingPercent / 100,
    remainingRequests: Math.round(remainingPercent),
    maxRequests: 100,
    usedRequests: 100 - Math.round(remainingPercent),
    resetTimeIso: resetIso,
    resetInHuman: resetText(resetTimestamp),
  };
}

function windowLabel(windowMinutes: number): string {
  const rounded = Math.round(windowMinutes);
  if (rounded === 300) return "5 hour usage";
  if (rounded > 0 && rounded % 1440 === 0) return `${rounded / 1440}d usage`;
  if (rounded > 0 && rounded % 60 === 0) return `${rounded / 60} hour usage`;
  return `${Math.round(windowMinutes)}m usage`;
}
