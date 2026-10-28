import { Effect } from "effect";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  resetIso,
  parseNumber,
  parseRecord,
  isoOf,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";

export function antigravityQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const projectId = account.projectId?.trim() ?? "";
  if (!projectId) {
    return Effect.succeed(
      errorInfo("Antigravity account is missing projectId. Re-authenticate this account.")
    );
  }
  const endpoints = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ];

  const attemptEndpoint = (endpoint: string): Effect.Effect<AccountQuotaInfo, string> =>
    quotaPayload(ctx, account, forceRefresh, {
      cache: "antigravity:fetchAvailableModels",
      method: "POST",
      url: `${endpoint}/v1internal:fetchAvailableModels`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": `antigravity/2.28.0 ${process.platform}/${process.arch}`,
      },
      body: { project: projectId },
      label: "Antigravity",
    }).pipe(
      Effect.flatMap((payload) =>
        payload.ok
          ? Effect.succeed(baseInfo("success", antigravityGroups(payload.data)))
          : Effect.fail(payload.info.error)
      )
    );

  const combined = endpoints.reduce<Effect.Effect<AccountQuotaInfo, string> | null>(
    (previous, endpoint) =>
      previous === null ? attemptEndpoint(endpoint) : previous.pipe(Effect.catch(() => attemptEndpoint(endpoint))),
    null
  ) as Effect.Effect<AccountQuotaInfo, string>;

  return combined.pipe(
    Effect.catch((message) =>
      Effect.succeed(errorInfo(`Failed to fetch Antigravity quota data: ${message}`))
    )
  );
}

function antigravityGroups(payload: Json): QuotaGroupDisplay[] {
  const models = parseRecord(payload.models) ?? {};

  const groups: Array<{ name: string; display: string; remainingFraction: number; resetIso: string | null }> = [
    { name: "claude", display: "Claude", remainingFraction: 1, resetIso: null },
    { name: "gemini", display: "Gemini", remainingFraction: 1, resetIso: null },
  ];

  for (const [modelId, entry] of Object.entries(models)) {
    const group = modelId.startsWith("gemini") ? groups[1] : groups[0];
    const modelRecord = parseRecord(entry);
    if (!modelRecord) continue;
    const quotaInfo = parseRecord(modelRecord.quotaInfo);
    if (!quotaInfo) continue;

    const value = quotaInfo.remainingFraction === undefined || quotaInfo.remainingFraction === null
      ? null
      : parseNumber(quotaInfo.remainingFraction);
    const fraction = value === null ? 0 : clampFraction(value);
    if (fraction < group.remainingFraction) group.remainingFraction = fraction;

    const iso = isoOf(quotaInfo.resetTime);
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
    resetInHuman: resetIso(group.resetIso),
  }));
}
