import { Effect } from "effect";
import { putQuotaCache } from "../cache.js";
import {
  baseQuotaInfo,
  clampFraction,
  displayNumber,
  errorQuotaInfo,
  formatTimeUntilResetIso,
  parseQuotaNumber,
  parseQuotaRecord,
  parseResetIso,
} from "../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "../types.js";
import { quotaAttempt, type Json } from "./shared.js";

export function fetchAntigravityQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const projectId = account.projectId?.trim() ?? "";
  if (!projectId) {
    return Effect.succeed(
      errorQuotaInfo("Antigravity account is missing projectId. Re-authenticate this account.")
    );
  }
  const endpoints = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ];

  const attemptEndpoint = (endpoint: string): Effect.Effect<AccountQuotaInfo, string> =>
    quotaAttempt(
      ctx,
      account,
      forceRefresh,
      "antigravity:fetchAvailableModels",
      "POST",
      `${endpoint}/v1internal:fetchAvailableModels`,
      {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/2.26.0 ${process.platform}/${process.arch}`,
      },
      { project: projectId }
    ).pipe(
      Effect.flatMap((attempt) => {
        if (!attempt.ok) return Effect.fail(attempt.message);
        const { result } = attempt;
        if (result.statusCode < 200 || result.statusCode >= 300) {
          return Effect.fail(`HTTP ${result.statusCode} ${result.raw}`);
        }
        const parsed = (() => {
          try {
            return JSON.parse(result.raw) as Json;
          } catch {
            return null;
          }
        })();
        if (!parsed) return Effect.fail("response was not valid JSON");
        return putQuotaCache(ctx, result).pipe(Effect.as(baseQuotaInfo("success", antigravityGroups(parsed))));
      })
    );

  const combined = endpoints.reduce<Effect.Effect<AccountQuotaInfo, string> | null>(
    (previous, endpoint) =>
      previous === null ? attemptEndpoint(endpoint) : previous.pipe(Effect.catch(() => attemptEndpoint(endpoint))),
    null
  ) as Effect.Effect<AccountQuotaInfo, string>;

  return combined.pipe(
    Effect.catch((message) =>
      Effect.succeed(errorQuotaInfo(`Failed to fetch Antigravity quota data: ${message}`))
    )
  );
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
