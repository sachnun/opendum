import { getQuotaJson, putQuotaCache, encodeQuery } from "./cache.js";
import {
  baseQuotaInfo,
  clampFraction,
  displayNumber,
  errorQuotaInfo,
  expiredQuotaInfo,
  firstNonEmpty,
  formatFloat,
  formatTimeUntilReset,
  formatTimeUntilResetIso,
  parseQuotaArray,
  parseQuotaNumber,
  parseQuotaRecord,
  parseQuotaString,
  parseResetIso,
} from "./helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "./types.js";

type Json = Record<string, unknown>;

export function quotaFallbackTier(account: QuotaAccount): string {
  const tier = account.tier?.trim();
  return tier ? tier : "free";
}

async function fetchJsonData(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean,
  cacheName: string,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ data: Json | null; error: string | null }> {
  let result;
  try {
    result = await getQuotaJson(ctx, account, forceRefresh, cacheName, method, target, headers, body);
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return { data: null, error: `HTTP ${result.statusCode} ${result.raw}` };
  }
  try {
    const parsed = JSON.parse(result.raw) as Json;
    void putQuotaCache(ctx, result);
    return { data: parsed, error: null };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fetchOpenRouterQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.");
  }
  const key = await fetchJsonData(ctx, account, forceRefresh, "openrouter:key", "GET", "https://openrouter.ai/api/v1/key", { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" }, null);
  const credits = await fetchJsonData(ctx, account, forceRefresh, "openrouter:credits", "GET", "https://openrouter.ai/api/v1/credits", { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" }, null);
  if (key.error && credits.error) return errorQuotaInfo(key.error);
  const keyData = parseQuotaRecord(key.data?.data) ?? {};
  const creditsData = parseQuotaRecord(credits.data?.data) ?? {};
  return baseQuotaInfo("success", openRouterGroups(keyData, creditsData));
}

function openRouterGroups(keyData: Json, creditsData: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const totalCredits = parseQuotaNumber(creditsData.total_credits);
  const totalUsage = parseQuotaNumber(creditsData.total_usage);
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
  const limit = parseQuotaNumber(keyData.limit);
  const remaining = parseQuotaNumber(keyData.limit_remaining);
  const hasKeyUsage = parseQuotaNumber(keyData.usage) !== null;
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
  const usageDaily = parseQuotaNumber(keyData.usage_daily);
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

const ANTIGRAVITY_CLAUDE_API = [
  "claude-opus-5-5-high", "claude-opus-5-5-medium", "claude-opus-5-5-low",
  "claude-sonnet-5-5-high", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-low",
  "claude-opus-4-6-thinking", "claude-sonnet-4-6", "gpt-oss-120b-medium",
];
const ANTIGRAVITY_GEMINI_API = [
  "gemini-3.8-flash-high", "gemini-3.1-pro-high", "gemini-3.5-flash-medium",
  "gemini-2.5-flash-thinking", "gemini-2.5-flash-lite",
];

export async function fetchAntigravityQuota(
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
  const configs = [
    { name: "claude", display: "Claude", models: ANTIGRAVITY_CLAUDE_API },
    { name: "gemini", display: "Gemini", models: ANTIGRAVITY_GEMINI_API },
  ];
  const groups: QuotaGroupDisplay[] = [];
  for (const cfg of configs) {
    let remainingFraction = 1;
    let resetIso: string | null = null;
    for (const apiModel of cfg.models) {
      const modelRecord = parseQuotaRecord(models[apiModel]);
      if (!modelRecord) continue;
      const quotaInfo = parseQuotaRecord(modelRecord.quotaInfo);
      if (!quotaInfo) continue;
      if (quotaInfo.remainingFraction === undefined || quotaInfo.remainingFraction === null) remainingFraction = 0;
      else {
        const value = parseQuotaNumber(quotaInfo.remainingFraction);
        if (value !== null) remainingFraction = clampFraction(value);
      }
      const iso = parseResetIso(quotaInfo.resetTime);
      if (iso) resetIso = iso;
      break;
    }
    groups.push({
      name: cfg.name,
      displayName: cfg.display,
      remainingFraction,
      remainingRequests: displayNumber(remainingFraction * 100),
      maxRequests: 100,
      usedRequests: displayNumber(100 - remainingFraction * 100),
      resetTimeIso: resetIso,
      resetInHuman: formatTimeUntilResetIso(resetIso),
    });
  }
  return groups;
}

export async function fetchCodexQuota(
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
  let payload: Json = {};
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

export async function fetchKiroQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const values = new URLSearchParams();
  values.set("origin", "AI_EDITOR");
  const profileArn = account.accountId?.trim() ?? "";
  if (profileArn) values.set("profileArn", profileArn);
  const target = encodeQuery("https://q.us-east-1.amazonaws.com/", values);
  const body: Json = { origin: "AI_EDITOR" };
  if (profileArn) body.profileArn = profileArn;
  let result;
  try {
    result = await getQuotaJson(ctx, account, forceRefresh, "kiro:GetUsageLimits", "POST", target, {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-amz-json-1.0",
      Accept: "application/json",
      "User-Agent": "KiroIDE-0.7.45",
      "x-amz-user-agent": "KiroIDE-0.7.45",
      "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
      "x-amzn-codewhisperer-optout": "true",
      "x-amzn-kiro-agent-mode": "vibe",
      "amz-sdk-request": "attempt=1; max=3",
    }, body);
  } catch (error) {
    return errorQuotaInfo(error instanceof Error ? error.message : String(error));
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return errorQuotaInfo(`Kiro usage limits quota endpoint failed: HTTP ${result.statusCode} ${result.raw}`);
  }
  let payload: Json;
  try {
    payload = JSON.parse(result.raw) as Json;
  } catch {
    return errorQuotaInfo("Kiro usage limits response was not valid JSON");
  }
  const record = parseQuotaRecord(payload.data) ?? payload;
  const groups = kiroGroups(record);
  if (groups.length === 0) return errorQuotaInfo("Kiro usage limits are unavailable for this account");
  await putQuotaCache(ctx, result);
  return baseQuotaInfo("success", groups);
}

function titleWords(value: string): string {
  return value.split(/\s+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function kiroGroups(record: Json): QuotaGroupDisplay[] {
  const labels: Record<string, string> = {
    AI_EDITOR: "Kiro requests", AGENTIC_REQUEST: "Agentic requests", CODE_COMPLETIONS: "Code completions",
    TRANSFORM: "Transform", CREDIT: "Credits", VIBE: "Vibe usage", SPEC: "Spec usage",
  };
  const metrics: Json[] = [];
  for (const raw of parseQuotaArray(record.limits)) {
    const metric = parseQuotaRecord(raw);
    if (metric) metrics.push(metric);
  }
  for (const raw of parseQuotaArray(record.usageBreakdownList)) {
    const metric = parseQuotaRecord(raw);
    if (metric) metrics.push(metric);
  }
  const groups: QuotaGroupDisplay[] = [];
  for (const metric of metrics) {
    const name = firstNonEmpty(
      parseQuotaString(metric.type),
      parseQuotaString(metric.resourceType),
      parseQuotaString(metric.displayName)
    ).toUpperCase();
    if (!name) continue;
    const current = firstNumber(metric.currentUsage, metric.currentUsageWithPrecision);
    const limit = firstNumber(metric.totalUsageLimit, metric.usageLimitWithPrecision, metric.usageLimit);
    if (current === null || limit === null || limit <= 0) continue;
    const remaining = Math.max(0, limit - current);
    const fraction = clampFraction(remaining / limit);
    const resetIso = parseResetIso(firstNonNull(metric.nextDateReset, record.nextDateReset));
    const display = labels[name] ?? titleWords(name.replace(/_/g, " ").toLowerCase());
    groups.push({
      name: name.toLowerCase(),
      displayName: display,
      remainingFraction: fraction,
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(limit),
      usedRequests: displayNumber(current),
      resetTimeIso: resetIso,
      resetInHuman: formatTimeUntilResetIso(resetIso),
    });
  }
  return groups;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = parseQuotaNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstNonNull(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export async function fetchZenmuxQuota(
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

export async function fetchHyperQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.");
  }
  const { data, error } = await fetchJsonData(
    ctx, account, forceRefresh, "hyper:credits", "GET", "https://hyper.charm.land/v1/credits",
    { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" }, null
  );
  if (error || !data) return errorQuotaInfo(error ?? "Charm credits request failed");
  return baseQuotaInfo("success", hyperGroups(data));
}

function hyperGroups(payload: Json): QuotaGroupDisplay[] {
  const balance = parseQuotaNumber(payload.balance);
  if (balance === null) {
    return [{
      name: "account-balance", displayName: "Balance", remainingFraction: 1, remainingRequests: 1,
      maxRequests: 1, usedRequests: 0, resetTimeIso: null, resetInHuman: null, remainingLabel: "active",
    }];
  }
  const usd = balance * 0.05;
  return [{
    name: "account-balance", displayName: "Balance", remainingFraction: 1,
    remainingRequests: usd, maxRequests: usd, usedRequests: 0, resetTimeIso: null, resetInHuman: null,
    remainingLabel: `$${usd.toFixed(2)}`,
  }];
}

const WORKBUDDY_SUMMARY_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-summary";
const WORKBUDDY_FREE_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages";
const WORKBUDDY_PAID_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-paid-packages";
const WORKBUDDY_DOMAIN = "www.workbuddy.ai";
const WORKBUDDY_PAGE_SIZE = 50;

export async function fetchWorkbuddyQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const token = accessToken.trim();
  if (!token) return expiredQuotaInfo("WorkBuddy access token is missing. Re-authenticate this account.");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Domain": WORKBUDDY_DOMAIN,
  };
  const userId = account.accountId?.trim() ?? "";
  if (userId) headers["X-User-Id"] = userId;

  let result;
  try {
    result = await getQuotaJson(ctx, account, forceRefresh, "workbuddy:resource-summary", "POST", WORKBUDDY_SUMMARY_URL, headers, {});
  } catch (error) {
    return errorQuotaInfo(error instanceof Error ? error.message : String(error));
  }
  if (result.statusCode === 401 || result.statusCode === 403) {
    return expiredQuotaInfo("WorkBuddy session is invalid or expired. Re-authenticate this account.");
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return errorQuotaInfo(`WorkBuddy quota endpoint failed: HTTP ${result.statusCode} ${result.raw}`);
  }
  let payload: { code?: number; msg?: string; data?: Json };
  try {
    payload = JSON.parse(result.raw) as { code?: number; msg?: string; data?: Json };
  } catch {
    return errorQuotaInfo("WorkBuddy quota response was not valid JSON");
  }
  if (payload.code !== 0) {
    return errorQuotaInfo(`WorkBuddy quota request failed: ${payload.code} ${payload.msg ?? ""}`);
  }
  const summary = payload.data ?? {};
  const packages = parseQuotaArray(summary.Packages).map((raw) => (parseQuotaRecord(raw) ?? {}) as Json);
  const details = await fetchWorkbuddyPackageDetails(ctx, account, headers, forceRefresh, packages);
  const groups = workbuddyQuotaGroups(packages, details);
  if (groups.length === 0) return errorQuotaInfo("WorkBuddy quota response did not include usable quota data");
  await putQuotaCache(ctx, result);
  return baseQuotaInfo("success", groups);
}

function workbuddyQuotaGroups(
  packages: Json[],
  details: Map<string, { packageName: string; cycleEndTime: string }>
): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  for (const pkg of packages) {
    const total = parseQuotaNumber(pkg.CycleTotalCapacity);
    let remaining = parseQuotaNumber(pkg.CycleRemainCapacity);
    let used = parseQuotaNumber(pkg.CycleUsedCapacity) ?? 0;
    if (total === null || remaining === null || total <= 0) continue;
    used = Math.min(Math.max(0, used), total);
    remaining = Math.max(0, Math.min(remaining, total));
    const fraction = clampFraction(remaining / total);
    const name = parseQuotaString(pkg.PackageCode) || "package";
    const detail = details.get(name);
    const display = workbuddyDisplayName(name, detail?.packageName ?? "");
    const resetIso = workbuddyResetIso(detail?.cycleEndTime ?? "");
    groups.push({
      name,
      displayName: display,
      remainingFraction: fraction,
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(total),
      usedRequests: displayNumber(used),
      resetTimeIso: resetIso,
      resetInHuman: formatTimeUntilResetIso(resetIso),
      remainingLabel: `${formatFloat(remaining)} / ${formatFloat(total)} credits`,
    });
  }
  return groups;
}

async function fetchWorkbuddyPackageDetails(
  ctx: QuotaContext,
  account: QuotaAccount,
  headers: Record<string, string>,
  forceRefresh: boolean,
  packages: Json[]
): Promise<Map<string, { packageName: string; cycleEndTime: string }>> {
  const out = new Map<string, { packageName: string; cycleEndTime: string }>();
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    const code = parseQuotaString(pkg.PackageCode);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  if (codes.length === 0) return out;
  const targets = [
    { cache: "workbuddy:resource-free-packages", url: WORKBUDDY_FREE_URL },
    { cache: "workbuddy:resource-paid-packages", url: WORKBUDDY_PAID_URL },
  ];
  for (const target of targets) {
    let result;
    try {
      result = await getQuotaJson(ctx, account, forceRefresh, target.cache, "POST", target.url, headers, {
        PackageCodes: codes,
        PageNumber: 1,
        PageSize: WORKBUDDY_PAGE_SIZE,
      });
    } catch {
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) continue;
    let payload: { code?: number; data?: { Accounts?: unknown[] } };
    try {
      payload = JSON.parse(result.raw) as { code?: number; data?: { Accounts?: unknown[] } };
    } catch {
      continue;
    }
    if (payload.code !== 0) continue;
    await putQuotaCache(ctx, result);
    for (const raw of parseQuotaArray(payload.data?.Accounts)) {
      const entry = parseQuotaRecord(raw);
      if (!entry) continue;
      const code = parseQuotaString(entry.PackageCode);
      if (!code || out.has(code)) continue;
      out.set(code, {
        packageName: parseQuotaString(entry.PackageName),
        cycleEndTime: parseQuotaString(entry.CycleEndTime),
      });
    }
  }
  return out;
}

function workbuddyDisplayName(packageCode: string, packageName: string): string {
  if (packageName.trim()) {
    const normalized = workbuddyNormalizePackageName(packageName);
    return normalized || packageName;
  }
  if (packageCode.startsWith("TCACA_code_006")) return "Bonus Pack";
  if (packageCode.startsWith("TCACA_code_035")) return "Free Plan";
  const trimmed = workbuddyStripRandomSuffix(packageCode);
  if (trimmed) return trimmed;
  if (packageCode) return packageCode;
  return "package";
}

function workbuddyNormalizePackageName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "free plan subscription") return "Free Plan";
  if (lower === "bonus pack") return "Bonus Pack";
  return name.trim();
}

function workbuddyStripRandomSuffix(code: string): string {
  const idx = code.lastIndexOf("_");
  if (idx <= 0 || idx + 1 >= code.length) return code.replace(/_/g, " ");
  const suffix = code.slice(idx + 1);
  if (suffix.length === 10 && /^[A-Za-z0-9]+$/.test(suffix)) {
    const base = code.slice(0, idx).replace(/^_+|_+$/g, "");
    if (!base) return "";
    if (base.startsWith("TCACA_code_")) {
      const number = base.slice("TCACA_code_".length).trim();
      if (number) return `Package ${number}`;
    }
    return base.replace(/_/g, " ");
  }
  return code.replace(/_/g, " ");
}

function workbuddyResetIso(cycleEndTime: string): string | null {
  const value = cycleEndTime.trim();
  if (!value) return null;
  const parsed = workbuddyParseCycleTime(value);
  return parsed ? parsed.toISOString() : null;
}

function workbuddyParseCycleTime(value: string): Date | null {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return new Date(direct);
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match) {
    const [, y, mo, d, h, mi, s] = match;
    const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s));
    return new Date(utcMs);
  }
  return null;
}
