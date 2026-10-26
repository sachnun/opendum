import { Effect } from "effect";
import { encodeQuery } from "@opendum/providers/quota/cache";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  firstValue,
  resetIso,
  parseArray,
  parseNumber,
  parseRecord,
  parseString,
  isoOf,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";

export function kiroQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const values = new URLSearchParams();
  values.set("origin", "AI_EDITOR");
  const profileArn = account.accountId?.trim() ?? "";
  if (profileArn) values.set("profileArn", profileArn);
  const target = encodeQuery("https://q.us-east-1.amazonaws.com/", values);
  const body: Json = { origin: "AI_EDITOR" };
  if (profileArn) body.profileArn = profileArn;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/x-amz-json-1.0",
    Accept: "application/json",
    "User-Agent": "KiroIDE-1.3.11",
    "x-amz-user-agent": "KiroIDE-1.3.11",
    "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
    "x-amzn-codewhisperer-optout": "true",
    "x-amzn-kiro-agent-mode": "vibe",
    "amz-sdk-request": "attempt=1; max=3",
  };

  return quotaPayload(ctx, account, forceRefresh, {
    cache: "kiro:GetUsageLimits",
    method: "POST",
    url: target,
    headers,
    body,
    label: "Kiro usage limits",
  }).pipe(
    Effect.map((payload) => {
      if (!payload.ok) return payload.info;
      const record = parseRecord(payload.data.data) ?? payload.data;
      const groups = kiroGroups(record);
      if (groups.length === 0) {
        return errorInfo("Kiro usage limits are unavailable for this account");
      }
      return baseInfo("success", groups);
    })
  );
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
  for (const raw of parseArray(record.limits)) {
    const metric = parseRecord(raw);
    if (metric) metrics.push(metric);
  }
  for (const raw of parseArray(record.usageBreakdownList)) {
    const metric = parseRecord(raw);
    if (metric) metrics.push(metric);
  }
  const groups: QuotaGroupDisplay[] = [];
  for (const metric of metrics) {
    const name = firstValue(
      parseString(metric.type),
      parseString(metric.resourceType),
      parseString(metric.displayName)
    ).toUpperCase();
    if (!name) continue;
    const current = firstNumber(metric.currentUsage, metric.currentUsageWithPrecision);
    const limit = firstNumber(metric.totalUsageLimit, metric.usageLimitWithPrecision, metric.usageLimit);
    if (current === null || limit === null || limit <= 0) continue;
    const remaining = Math.max(0, limit - current);
    const fraction = clampFraction(remaining / limit);
    const resetValue = isoOf(firstDefined(metric.nextDateReset, record.nextDateReset));
    const display = labels[name] ?? titleWords(name.replace(/_/g, " ").toLowerCase());
    groups.push({
      name: name.toLowerCase(),
      displayName: display,
      remainingFraction: fraction,
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(limit),
      usedRequests: displayNumber(current),
      resetTimeIso: resetValue,
      resetInHuman: resetIso(resetValue),
    });
  }
  return groups;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined) return value;
  }
  return null;
}
