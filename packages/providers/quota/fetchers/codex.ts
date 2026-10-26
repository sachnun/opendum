import { Effect } from "effect";
import { putQuota } from "../cache.js";
import {
  baseInfo,
  errorInfo,
  resetText,
  parseNumber,
  parseRecord,
  parseString,
} from "../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "../types.js";
import { quotaAttempt, fallbackTier, type Json } from "./shared.js";

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
    "User-Agent": `opencode/1.19.4 (${process.platform} ${process.platform}; ${process.arch})`,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    originator: "opencode",
  };
  const accountId = account.accountId?.trim() || jwtAccount(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  return quotaAttempt(
    ctx,
    account,
    forceRefresh,
    "codex:usage",
    "GET",
    "https://chatgpt.com/backend-api/wham/usage",
    headers,
    null
  ).pipe(
    Effect.flatMap((attempt) => {
      if (!attempt.ok) return Effect.succeed(errorInfo(attempt.message));
      const { result } = attempt;
      const headerResult = headerGroups(result.header, defaultTier);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        if (headerResult.length > 0) return Effect.succeed(baseInfo("success", headerResult));
        return Effect.succeed(
          errorInfo(`Codex quota endpoint failed: HTTP ${result.statusCode} ${result.raw}`)
        );
      }
      const payload = (() => {
        try {
          return JSON.parse(result.raw) as Json;
        } catch {
          return {} as Json;
        }
      })();
      const tier = parseString(payload.plan_type) || defaultTier;
      const apiResult = apiGroups(payload, tier);
      const groups = apiResult.length > 0 ? apiResult : headerResult;
      if (groups.length === 0) {
        return Effect.succeed(errorInfo("Codex quota payload did not include usable quota data"));
      }
      return putQuota(ctx, result).pipe(Effect.as(baseInfo("success", groups)));
    })
  );
}

function jwtAccount(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1].trim()) return "";
  let claims: Json;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Json;
  } catch {
    return "";
  }
  const authClaims = parseRecord(claims["https://api.openai.com/auth"]);
  if (authClaims) {
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = parseString(authClaims[key]);
      if (value) return value;
    }
  }
  for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
    const value = parseString(claims[key]);
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
