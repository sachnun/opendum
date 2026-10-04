import { encodeQuery, getQuotaJson, putQuotaCache } from "../../cache.js";
import { baseQuotaInfo, clampFraction, displayNumber, errorQuotaInfo, firstNonEmpty, formatTimeUntilResetIso, parseQuotaArray, parseQuotaNumber, parseQuotaRecord, parseQuotaString, parseResetIso } from "../../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "../../types.js";
import type { Json } from "../common.js";

export const provider: QuotaProvider = {
  name: "kiro",
  fetch: (ctx, account, token, forceRefresh) => fetchKiroQuota(ctx, account, token, forceRefresh),
};

async function fetchKiroQuota(
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
