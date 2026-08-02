import type Redis from "ioredis";
import type { ProxyDB, ProviderAccount } from "../../db/index.js";
import { schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import type { Registry } from "../../registry/index.js";
import { decrypt } from "../../crypto/index.js";
import type { HttpClient, RequestContext } from "../../providers/types.js";
import { getQuotaJSON, putQuotaJSONCache, parseQuotaRecord, parseQuotaString, parseQuotaNumber, parseQuotaArray, firstNumber, firstNonNil, firstNonEmpty, formatFloat, clampFraction, displayNumber, formatTimeUntilReset, formatTimeUntilResetISO, type AccountQuotaInfo, type QuotaGroupDisplay, baseQuotaInfo, errorQuotaInfo, expiredQuotaInfo, quotaFallbackTier } from "./quota.js";

const antigravityQuotaMaxRequests: Record<string, Record<string, number>> = {
  "standard-tier": { "claude-opus-4-6": 150, "claude-sonnet-4-6": 150, "gemini-3.1-pro-preview": 320, "gemini-3.5-flash": 400, "gpt-oss-120b": 100 },
  "free-tier": { "claude-opus-4-6": 50, "claude-sonnet-4-6": 50, "gemini-3.1-pro-preview": 150, "gemini-3.5-flash": 500, "gpt-oss-120b": 100 },
  "legacy-tier": { "claude-opus-4-6": 50, "claude-sonnet-4-6": 50, "gemini-3.1-pro-preview": 150, "gemini-3.5-flash": 500, "gpt-oss-120b": 100 },
};

export interface QuotaFetcherDeps {
  client: HttpClient;
  ctx: RequestContext;
  redis: Redis | null;
  db: ProxyDB | null;
  secret: string;
  registry: Registry | null;
  getProviderCredentials: (account: ProviderAccount) => Promise<[string, ProviderAccount, Error | null]>;
  decryptSecret: (ciphertext: string) => string;
}

export async function fetchOpenRouterQuota(deps: QuotaFetcherDeps, account: ProviderAccount, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = deps.decryptSecret(account.accessToken);
  } catch {
    return expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.");
  }
  const [keyData, keyErr] = await fetchOpenRouterData(deps, account, apiKey, "/key", forceRefresh);
  const [creditsData, creditsErr] = await fetchOpenRouterData(deps, account, apiKey, "/credits", forceRefresh);
  if (keyErr && creditsErr) {
    return errorQuotaInfo(keyErr);
  }
  return baseQuotaInfo("success", openRouterGroups(keyData ?? {}, creditsData ?? {}), "");
}

async function fetchOpenRouterData(deps: QuotaFetcherDeps, account: ProviderAccount, apiKey: string, path: string, forceRefresh: boolean): Promise<[Record<string, unknown> | null, string | null]> {
  const result = await getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, "openrouter:" + path.replace(/^\//, ""), "GET", "https://openrouter.ai/api/v1" + path, { authorization: "Bearer " + apiKey.trim(), accept: "application/json" }, null);
  if (result.status < 200 || result.status >= 300) {
    return [null, `OpenRouter${path} request failed: HTTP ${result.status} ${result.raw}`];
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.raw) as Record<string, unknown>;
  } catch {
    return [null, `OpenRouter${path} response was not valid JSON`];
  }
  const data = parseQuotaRecord(payload["data"]);
  if (data === null) {
    return [null, `OpenRouter${path} response did not include a data object`];
  }
  await putQuotaJSONCache(deps.redis, result, result.headers);
  return [data, null];
}

export function openRouterGroups(keyData: Record<string, unknown>, creditsData: Record<string, unknown>): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const [totalCredits, hasTotal] = parseQuotaNumber(creditsData["total_credits"]);
  const [totalUsage, hasUsage] = parseQuotaNumber(creditsData["total_usage"]);
  if (hasTotal && hasUsage && totalCredits > 0) {
    const remaining = Math.max(0, totalCredits - totalUsage);
    const fraction = clampFraction(remaining / totalCredits);
    const label = `$${(remaining).toFixed(2)} / $${totalCredits.toFixed(2)}`;
    groups.push({ name: "account-credits", displayName: "Account credits", models: [], remainingFraction: fraction, remainingRequests: displayNumber(remaining), maxRequests: displayNumber(totalCredits), usedRequests: displayNumber(totalCredits - remaining), percentUsed: Math.round(clampFraction((totalCredits - remaining) / totalCredits) * 100), isExhausted: fraction <= 0, isEstimated: false, confidence: "high", resetTimeIso: null, resetInHuman: null, remainingLabel: label });
  }
  const [limit, hasLimit] = parseQuotaNumber(keyData["limit"]);
  const [remaining, hasRemaining] = parseQuotaNumber(keyData["limit_remaining"]);
  const [, hasKeyUsage] = parseQuotaNumber(keyData["usage"]);
  if (hasLimit && hasRemaining && hasKeyUsage && limit > 0) {
    const fraction = clampFraction(remaining / limit);
    const label = `$${remaining.toFixed(2)} / $${limit.toFixed(2)}`;
    groups.push({ name: "key-limit", displayName: "API key limit", models: [], remainingFraction: fraction, remainingRequests: displayNumber(remaining), maxRequests: displayNumber(limit), usedRequests: displayNumber(Math.max(0, limit - remaining)), percentUsed: Math.round(clampFraction((limit - remaining) / limit) * 100), isExhausted: fraction <= 0, isEstimated: false, confidence: "high", resetTimeIso: null, resetInHuman: null, remainingLabel: label });
  }
  if (groups.length > 0) return groups;
  const [usageDaily, ok] = parseQuotaNumber(keyData["usage_daily"]);
  if (ok) {
    return [{ name: "daily-usage", displayName: "Today usage", models: [], remainingFraction: 1, remainingRequests: 1, maxRequests: 1, usedRequests: 0, percentUsed: 0, isExhausted: false, isEstimated: true, confidence: "medium", resetTimeIso: null, resetInHuman: "resets daily", remainingLabel: `$${usageDaily.toFixed(2)}` }];
  }
  let label = "active";
  if (keyData["is_free_tier"] === true) label = "free tier";
  return [{ name: "key-status", displayName: "OpenRouter key", models: [], remainingFraction: 1, remainingRequests: 1, maxRequests: 1, usedRequests: 0, percentUsed: 0, isExhausted: false, isEstimated: true, confidence: "low", resetTimeIso: null, resetInHuman: null, remainingLabel: label }];
}

export async function fetchSiliconFlowQuota(deps: QuotaFetcherDeps, account: ProviderAccount, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = deps.decryptSecret(account.accessToken);
  } catch {
    return expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.");
  }
  const result = await getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, "siliconflow:user-info", "GET", "https://api.siliconflow.com/v1/user/info", { authorization: "Bearer " + apiKey.trim(), accept: "application/json" }, null);
  if (result.status < 200 || result.status >= 300) {
    return errorQuotaInfo(`SiliconFlow user info endpoint failed: HTTP ${result.status} ${result.raw}`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.raw) as Record<string, unknown>;
  } catch {
    return errorQuotaInfo("SiliconFlow user info response was not valid JSON");
  }
  const data = parseQuotaRecord(payload["data"]);
  if (data === null) {
    return errorQuotaInfo("SiliconFlow user info response did not include a data object");
  }
  await putQuotaJSONCache(deps.redis, result, result.headers);
  return baseQuotaInfo("success", siliconFlowGroups(data), "");
}

export function siliconFlowGroups(data: Record<string, unknown>): QuotaGroupDisplay[] {
  let [total, hasTotal] = parseQuotaNumber(data["totalBalance"]);
  if (!hasTotal) [total, hasTotal] = parseQuotaNumber(data["balance"]);
  if (!hasTotal) {
    return [{ name: "account-balance", displayName: "Account balance", models: [], remainingFraction: 1, remainingRequests: 1, maxRequests: 1, usedRequests: 0, percentUsed: 0, isExhausted: false, isEstimated: true, confidence: "low", resetTimeIso: null, resetInHuman: null, remainingLabel: "active" }];
  }
  return [{ name: "account-balance", displayName: "Account balance", models: [], remainingFraction: 1, remainingRequests: 1, maxRequests: 1, usedRequests: 0, percentUsed: 0, isExhausted: total <= 0, isEstimated: true, confidence: "medium", resetTimeIso: null, resetInHuman: null, remainingLabel: `$${total.toFixed(2)}` }];
}

export async function fetchAntigravityQuota(deps: QuotaFetcherDeps, account: ProviderAccount, accessToken: string, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  const tier = quotaFallbackTier(account);
  const projectID = account.projectId !== null ? account.projectId.trim() : "";
  if (projectID === "") {
    return errorQuotaInfo("Antigravity account is missing projectId. Re-authenticate this account.");
  }
  const endpoints = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"];
  let lastErr = "";
  for (const endpoint of endpoints) {
    const result = await getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, "antigravity:fetchAvailableModels", "POST", endpoint + "/v1internal:fetchAvailableModels", { authorization: "Bearer " + accessToken, "content-type": "application/json", "user-agent": "antigravity/1.23.2 linux/amd64" }, { project: projectID });
    if (result.status < 200 || result.status >= 300) {
      lastErr = `HTTP ${result.status} ${result.raw}`;
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(result.raw) as Record<string, unknown>;
    } catch (error) {
      lastErr = (error as Error).message;
      continue;
    }
    await putQuotaJSONCache(deps.redis, result, result.headers);
    return baseQuotaInfo("success", antigravityGroups(payload, tier), "");
  }
  return errorQuotaInfo("Failed to fetch Antigravity quota data: " + lastErr);
}

export function antigravityGroups(payload: Record<string, unknown>, tier: string): QuotaGroupDisplay[] {
  const models = parseQuotaRecord(payload["models"]) ?? {};
  const apiNames: Record<string, string> = { "claude-opus-4-6": "claude-opus-4-6-thinking", "gemini-2.5-flash": "gemini-2.5-flash-thinking", "gemini-3.1-pro-preview": "gemini-3.1-pro-high", "gemini-3.5-flash": "gemini-3.5-flash-medium", "gpt-oss-120b": "gpt-oss-120b-medium" };
  const configs = [
    { name: "claude", display: "Claude", models: ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-oss-120b"] },
    { name: "gemini", display: "Gemini", models: ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"] },
  ];
  const groups: QuotaGroupDisplay[] = [];
  for (const cfg of configs) {
    let remainingFraction = 1.0;
    let resetISO: string | null = null;
    for (const model of cfg.models) {
      let apiModel = apiNames[model] ?? "";
      if (apiModel === "") apiModel = model;
      const modelRecord = parseQuotaRecord(models[apiModel]) ?? {};
      const quotaInfo = parseQuotaRecord(modelRecord["quotaInfo"]);
      if (quotaInfo === null) continue;
      if (quotaInfo["remainingFraction"] === undefined || quotaInfo["remainingFraction"] === null) {
        remainingFraction = 0;
      } else {
        const [value, ok] = parseQuotaNumber(quotaInfo["remainingFraction"]);
        if (ok) remainingFraction = clampFraction(value);
      }
      const iso = parseResetISO(quotaInfo["resetTime"]);
      if (iso !== null) resetISO = iso;
      break;
    }
    const maxRequests = antigravityMaxRequests(cfg.models[0]!, tier);
    const remaining = Math.max(0, Math.floor(remainingFraction * maxRequests));
    const percentUsed = Math.round(clampFraction((maxRequests - remaining) / maxRequests) * 100);
    groups.push({ name: cfg.name, displayName: cfg.display, models: cfg.models, remainingFraction, remainingRequests: remaining, maxRequests, usedRequests: maxRequests - remaining, percentUsed, isExhausted: remainingFraction <= 0, isEstimated: true, confidence: "medium", resetTimeIso: resetISO, resetInHuman: formatTimeUntilResetISO(resetISO), remainingLabel: `${Math.round(remainingFraction * 100)}%` });
  }
  return groups;
}

function antigravityMaxRequests(model: string, tier: string): number {
  const tierMap = antigravityQuotaMaxRequests[normalizeAntigravityQuotaTier(tier)];
  if (tierMap && tierMap[model] !== undefined && tierMap[model]! > 0) return tierMap[model]!;
  const freeMap = antigravityQuotaMaxRequests["free-tier"];
  if (freeMap && freeMap[model] !== undefined && freeMap[model]! > 0) return freeMap[model]!;
  return 100;
}

function normalizeAntigravityQuotaTier(tier: string): string {
  switch (tier.trim().toLowerCase()) {
    case "standard-tier":
    case "paid":
      return "standard-tier";
    case "legacy-tier":
      return "legacy-tier";
    case "free-tier":
    case "free":
      return "free-tier";
    default:
      return tier.trim().toLowerCase();
  }
}

function parseResetISO(value: unknown): string | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return null;
  }
  if (typeof value === "number") {
    let ms = Math.floor(value * 1000);
    if (value > 10000000000) ms = Math.floor(value);
    return new Date(ms).toISOString();
  }
  if (value && typeof value === "object") {
    const [seconds, ok] = parseQuotaNumber((value as Record<string, unknown>)["seconds"]);
    if (ok) return new Date(seconds * 1000).toISOString();
  }
  return null;
}

export async function fetchCodexQuota(deps: QuotaFetcherDeps, account: ProviderAccount, accessToken: string, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  const fallbackTier = quotaFallbackTier(account);
  const headers: Record<string, string> = { authorization: "Bearer " + accessToken, accept: "application/json", "user-agent": "opencode/1.14.28 (linux linux; amd64)", origin: "https://chatgpt.com", referer: "https://chatgpt.com/", originator: "opencode" };
  const accountID = accountIDForQuotaCodex(account, accessToken);
  if (accountID !== "") headers["chatgpt-account-id"] = accountID;

  const result = await getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, "codex:usage", "GET", "https://chatgpt.com/backend-api/wham/usage", headers, null);
  const headerData = parseCodexQuotaHeaderGroups(result.headers, fallbackTier);
  if (result.status < 200 || result.status >= 300) {
    if (headerData.length > 0) return baseQuotaInfo("success", headerData, "");
    return errorQuotaInfo(`Codex quota endpoint failed: HTTP ${result.status} ${result.raw}`);
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(result.raw) as Record<string, unknown>;
  } catch {
    // keep empty
  }
  let tier = parseQuotaString(payload["plan_type"]);
  if (tier === "") tier = fallbackTier;
  const apiGroups = parseCodexAPIGroups(payload, tier);
  if (apiGroups.length > 0) {
    await putQuotaJSONCache(deps.redis, result, result.headers);
    return baseQuotaInfo("success", apiGroups, "");
  }
  if (headerData.length > 0) {
    await putQuotaJSONCache(deps.redis, result, result.headers);
    return baseQuotaInfo("success", headerData, "");
  }
  return errorQuotaInfo("Codex quota payload did not include usable quota data");
}

function accountIDForQuotaCodex(account: ProviderAccount, accessToken: string): string {
  if (account.accountId !== null && account.accountId.trim() !== "") return account.accountId.trim();
  return extractQuotaAccountIDFromJWT(accessToken);
}

function extractQuotaAccountIDFromJWT(token: string): string {
  const parts = token.split(".");
  if (parts.length < 2 || parts[1]!.trim() === "") return "";
  let payload: string;
  try {
    payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
  } catch {
    return "";
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return "";
  }
  const authClaims = parseQuotaRecord(claims["https://api.openai.com/auth"]);
  if (authClaims !== null) {
    for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
      const value = parseQuotaString(authClaims[key]);
      if (value !== "") return value;
    }
  }
  for (const key of ["chatgpt_workspace_id", "workspace_id", "organization_id"]) {
    const value = parseQuotaString(claims[key]);
    if (value !== "") return value;
  }
  return "";
}

function parseCodexAPIGroups(payload: Record<string, unknown>, tier: string): QuotaGroupDisplay[] {
  const rateLimit = parseQuotaRecord(payload["rate_limit"]) ?? {};
  return codexWindowGroups("primary", parseQuotaRecord(rateLimit["primary_window"]) ?? {}, "secondary", parseQuotaRecord(rateLimit["secondary_window"]) ?? {}, tier, true);
}

function parseCodexQuotaHeaderGroups(headers: Record<string, string>, tier: string): QuotaGroupDisplay[] {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const primary: Record<string, unknown> = { used_percent: lower["x-codex-primary-used-percent"], limit_window_minutes: lower["x-codex-primary-window-minutes"], reset_at: lower["x-codex-primary-reset-at"] };
  const secondary: Record<string, unknown> = { used_percent: lower["x-codex-secondary-used-percent"], limit_window_minutes: lower["x-codex-secondary-window-minutes"], reset_at: lower["x-codex-secondary-reset-at"] };
  return codexWindowGroups("primary", primary, "secondary", secondary, tier, false);
}

function codexWindowGroups(primaryName: string, primary: Record<string, unknown>, secondaryName: string, secondary: Record<string, unknown>, tier: string, apiNames: boolean): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const [g1, ok1] = codexWindowGroup(primaryName, primary, tier, apiNames);
  if (ok1) groups.push(g1);
  const [g2, ok2] = codexWindowGroup(secondaryName, secondary, tier, apiNames);
  if (ok2) groups.push(g2);
  return groups;
}

function codexWindowGroup(name: string, record: Record<string, unknown>, tier: string, apiNames: boolean): [QuotaGroupDisplay, boolean] {
  const [used, ok] = parseQuotaNumber(record["used_percent"]);
  if (!ok) return [null as unknown as QuotaGroupDisplay, false];
  let [windowMinutes] = parseQuotaNumber(record["window_minutes"]);
  if (!apiNames) {
    [windowMinutes] = parseQuotaNumber(record["limit_window_minutes"]);
  } else if (windowMinutes === 0) {
    const [seconds] = parseQuotaNumber(record["limit_window_seconds"]);
    windowMinutes = Math.ceil(seconds / 60);
  }
  let [resetAt] = parseQuotaNumber(record["reset_at"]);
  let resetTimestamp = 0;
  if (resetAt > 10000000000) {
    resetTimestamp = Math.floor(resetAt);
  } else if (resetAt > 0) {
    resetTimestamp = Math.floor(resetAt * 1000);
  }
  const remainingPercent = Math.max(0, 100 - used);
  let display = "Usage";
  if (name === "secondary") {
    display = "Weekly usage";
  } else if (windowMinutes > 0) {
    display = codexWindowDisplayName(windowMinutes);
  }

  return [{
    name,
    displayName: display,
    models: [],
    remainingFraction: remainingPercent / 100,
    remainingRequests: Math.round(remainingPercent),
    maxRequests: 100,
    usedRequests: 100 - Math.round(remainingPercent),
    percentUsed: Math.round(used),
    isExhausted: used >= 100,
    isEstimated: false,
    confidence: "high",
    resetTimeIso: resetISOFromMillis(resetTimestamp),
    resetInHuman: formatTimeUntilReset(resetTimestamp),
    remainingLabel: null,
  }, true];
}

function codexWindowDisplayName(windowMinutes: number): string {
  const roundedMinutes = Math.round(windowMinutes);
  if (roundedMinutes === 300) return "5 hour usage";
  if (roundedMinutes > 0 && roundedMinutes % 1440 === 0) return `${roundedMinutes / 1440}d usage`;
  if (roundedMinutes > 0 && roundedMinutes % 60 === 0) return `${roundedMinutes / 60} hour usage`;
  return `${windowMinutes.toFixed(0)}m usage`;
}

function resetISOFromMillis(ms: number): string | null {
  if (ms <= 0) return null;
  return new Date(ms).toISOString();
}

export async function fetchKiroQuota(deps: QuotaFetcherDeps, account: ProviderAccount, accessToken: string, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  const values = new URLSearchParams();
  values.set("origin", "AI_EDITOR");
  if (account.accountId !== null && account.accountId.trim() !== "") {
    values.set("profileArn", account.accountId.trim());
  }
  const target = values.size > 0 ? "https://q.us-east-1.amazonaws.com/?" + values.toString() : "https://q.us-east-1.amazonaws.com/";
  const body: Record<string, unknown> = { origin: "AI_EDITOR" };
  if (values.get("profileArn")) body["profileArn"] = values.get("profileArn");

  const result = await getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, "kiro:GetUsageLimits", "POST", target, { authorization: "Bearer " + accessToken, "content-type": "application/x-amz-json-1.0", accept: "application/json", "user-agent": "KiroIDE-0.7.45", "x-amz-user-agent": "KiroIDE-0.7.45", "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits", "x-amzn-codewhisperer-optout": "true", "x-amzn-kiro-agent-mode": "vibe", "amz-sdk-request": "attempt=1; max=3" }, body);
  if (result.status < 200 || result.status >= 300) {
    return errorQuotaInfo(`Kiro usage limits quota endpoint failed: HTTP ${result.status} ${result.raw}`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.raw) as Record<string, unknown>;
  } catch {
    return errorQuotaInfo("Kiro usage limits response was not valid JSON");
  }
  let record = parseQuotaRecord(payload["data"]);
  if (record === null) record = payload;
  let tier = kiroTier(record);
  if (tier === "") tier = quotaFallbackTier(account);
  const groups = kiroGroups(record);
  if (groups.length === 0) {
    return errorQuotaInfo("Kiro usage limits are unavailable for this account");
  }
  await putQuotaJSONCache(deps.redis, result, result.headers);
  return baseQuotaInfo("success", groups, "");
}

function kiroTier(record: Record<string, unknown>): string {
  const sub = parseQuotaRecord(record["subscriptionInfo"]) ?? {};
  return normalizeKiroSubscriptionTier(parseQuotaString(sub["type"]), parseQuotaString(sub["subscriptionTitle"]));
}

function normalizeKiroSubscriptionTier(rawType: string, subscriptionTitle: string): string {
  switch (rawType.trim().toUpperCase()) {
    case "Q_DEVELOPER_STANDALONE_FREE":
      return "free";
    case "Q_DEVELOPER_STANDALONE_POWER":
      return "power";
    case "Q_DEVELOPER_STANDALONE_PRO":
      return "pro";
    case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
      return "pro-plus";
    case "Q_DEVELOPER_STANDALONE":
      return "standalone";
  }
  const title = subscriptionTitle.trim().toLowerCase();
  if (title === "") return "";
  if (title.includes("pro+") || title.includes("pro plus")) return "pro-plus";
  if (title.includes("power")) return "power";
  if (title.includes("pro")) return "pro";
  if (title.includes("free")) return "free";
  return title.replace(/_/g, " ").replace(/-/g, " ").split(/\s+/).join("-");
}

function kiroGroups(record: Record<string, unknown>): QuotaGroupDisplay[] {
  const labels: Record<string, string> = { AI_EDITOR: "Kiro requests", AGENTIC_REQUEST: "Agentic requests", CODE_COMPLETIONS: "Code completions", TRANSFORM: "Transform", CREDIT: "Credits", VIBE: "Vibe usage", SPEC: "Spec usage" };
  const metrics: Array<Record<string, unknown>> = [];
  for (const raw of parseQuotaArray(record["limits"])) {
    const metric = parseQuotaRecord(raw);
    if (metric) metrics.push(metric);
  }
  for (const raw of parseQuotaArray(record["usageBreakdownList"])) {
    const metric = parseQuotaRecord(raw);
    if (metric) metrics.push(metric);
  }
  const groups: QuotaGroupDisplay[] = [];
  for (const metric of metrics) {
    const name = firstNonEmpty(parseQuotaString(metric["type"]), parseQuotaString(metric["resourceType"]), parseQuotaString(metric["displayName"])).toUpperCase();
    if (name === "") continue;
    const [current, okCurrent] = firstNumber(metric["currentUsage"], metric["currentUsageWithPrecision"]);
    const [limit, okLimit] = firstNumber(metric["totalUsageLimit"], metric["usageLimitWithPrecision"], metric["usageLimit"]);
    if (!okCurrent || !okLimit || limit <= 0) continue;
    const remaining = Math.max(0, limit - current);
    const fraction = clampFraction(remaining / limit);
    const percentUsed = Math.round(clampFraction(current / limit) * 100);
    const resetISO = parseResetISO(firstNonNil(metric["nextDateReset"], record["nextDateReset"]));
    const display = labels[name] ?? titleCase(name.replace(/_/g, " "));
    groups.push({ name: name.toLowerCase(), displayName: display, models: [], remainingFraction: fraction, remainingRequests: displayNumber(remaining), maxRequests: displayNumber(limit), usedRequests: displayNumber(current), percentUsed, isExhausted: fraction <= 0, isEstimated: false, confidence: "high", resetTimeIso: resetISO, resetInHuman: formatTimeUntilResetISO(resetISO), remainingLabel: null });
  }
  return groups;
}

function titleCase(value: string): string {
  return value.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export async function fetchZenmuxQuota(deps: QuotaFetcherDeps, account: ProviderAccount, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  const platformKey = account.accountId;
  if (platformKey === null || platformKey.trim() === "") {
    return expiredQuotaInfo("Platform key is required for ZenMux quota.");
  }
  const result = await getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, "zenmux:subscription", "GET", "https://zenmux.ai/api/v1/management/subscription/detail", { authorization: "Bearer " + platformKey.trim(), accept: "application/json" }, null);
  if (result.status < 200 || result.status >= 300) {
    return errorQuotaInfo(`ZenMux subscription endpoint failed: HTTP ${result.status} ${result.raw}`);
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.raw) as Record<string, unknown>;
  } catch {
    return errorQuotaInfo("ZenMux subscription response was not valid JSON");
  }
  const data = parseQuotaRecord(payload["data"]);
  if (data === null) {
    return errorQuotaInfo("ZenMux subscription response did not include data");
  }
  await putQuotaJSONCache(deps.redis, result, result.headers);
  return baseQuotaInfo("success", zenmuxGroups(data), "");
}

export function zenmuxGroups(data: Record<string, unknown>): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const windows = [
    { key: "quota_5_hour", display: "5-Hour Window" },
    { key: "quota_7_day", display: "7-Day Window" },
  ];
  for (const w of windows) {
    const win = parseQuotaRecord(data[w.key]);
    if (win === null) continue;
    const [maxVal, hasMax] = parseQuotaNumber(win["max_flows"]);
    const [usedVal, hasUsed] = parseQuotaNumber(win["used_flows"]);
    const [remainingVal, hasRemaining] = parseQuotaNumber(win["remaining_flows"]);
    if (!hasMax || !hasUsed || !hasRemaining || maxVal <= 0) continue;
    const fraction = clampFraction(remainingVal / maxVal);
    const resetRaw = parseQuotaString(win["resets_at"]);
    let resetISO: string | null = null;
    if (resetRaw !== "") {
      const parsed = new Date(resetRaw);
      if (!Number.isNaN(parsed.getTime())) resetISO = parsed.toISOString();
    }
    const remainingLabel = `${formatFloat(remainingVal)} / ${formatFloat(maxVal)} flows`;
    groups.push({ name: w.key, displayName: w.display, models: [], remainingFraction: fraction, remainingRequests: displayNumber(remainingVal), maxRequests: displayNumber(maxVal), usedRequests: displayNumber(usedVal), percentUsed: Math.round(clampFraction((maxVal - remainingVal) / maxVal) * 100), isExhausted: fraction <= 0, isEstimated: false, confidence: "high", resetTimeIso: resetISO, resetInHuman: formatTimeUntilResetISO(resetISO), remainingLabel });
  }
  if (groups.length === 0) {
    return [{ name: "account-status", displayName: "Account status", models: [], remainingFraction: 1, remainingRequests: 1, maxRequests: 1, usedRequests: 0, percentUsed: 0, isExhausted: false, isEstimated: true, confidence: "low", resetTimeIso: null, resetInHuman: null, remainingLabel: "active" }];
  }
  return groups;
}

// Re-export parseResetISO for quota-commandcode
export function parseResetISOExport(value: unknown): string | null {
  return parseResetISO(value);
}

export async function loadQuotaAccount(db: ProxyDB | null, input: { userId: string; provider: string; accountId: string }): Promise<ProviderAccount | null> {
  if (!db) return null;
  const rows = await db
    .select()
    .from(schema.providerAccount)
    .where(and(eq(schema.providerAccount.id, input.accountId), eq(schema.providerAccount.userId, input.userId), eq(schema.providerAccount.provider, input.provider)))
    .limit(1);
  return rows.length > 0 ? (rows[0] as ProviderAccount) : null;
}

import { and } from "drizzle-orm";
