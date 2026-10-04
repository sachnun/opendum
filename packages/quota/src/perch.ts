import { getQuotaJson, putQuotaCache } from "./cache.js";
import {
  baseQuotaInfo,
  clampFraction,
  displayNumber,
  errorQuotaInfo,
  expiredQuotaInfo,
  formatFloat,
  formatTimeUntilResetIso,
  parseQuotaNumber,
  parseQuotaRecord,
  parseResetIso,
} from "./helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "./types.js";

type Json = Record<string, unknown>;

const PERCH_ACCOUNT_URL = "https://app.perchai.app/api/perchai/account";
const PERCH_MONTHLY_PT_FALLBACK = 20000;
const PERCH_PT_PER_USD = 1000;

export async function fetchPerchQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const token = accessToken.trim();
  if (!token) return expiredQuotaInfo("Perch access token is missing. Re-authenticate this account.");
  let result;
  try {
    result = await getQuotaJson(ctx, account, forceRefresh, "perch:account", "GET", PERCH_ACCOUNT_URL, {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    }, null);
  } catch (error) {
    return errorQuotaInfo(error instanceof Error ? error.message : String(error));
  }
  if (result.statusCode === 401 || result.statusCode === 403) {
    return expiredQuotaInfo("Perch session is invalid or expired. Re-authenticate this account.");
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    return errorQuotaInfo(`Perch account quota endpoint failed: HTTP ${result.statusCode} ${result.raw}`);
  }
  let payload: Json;
  try {
    payload = JSON.parse(result.raw) as Json;
  } catch {
    return errorQuotaInfo("Perch account response was not valid JSON");
  }
  if (payload.ok !== true) {
    return errorQuotaInfo("Perch account request was rejected. Re-authenticate this account.");
  }
  const session = parseQuotaRecord(payload.session) ?? {};
  if (session.tierSelectionRequired === true) {
    return expiredQuotaInfo("Perch account has no active plan yet. Re-authenticate to select the Starter plan.");
  }
  const groups = perchQuotaGroups(payload, session);
  if (groups.length === 0) return errorQuotaInfo("Perch account has no usage or allowance data");
  await putQuotaCache(ctx, result);
  return baseQuotaInfo("success", groups);
}

function perchMonthlyPtLimit(session: Json): number {
  const entitlements = Array.isArray(session.entitlements) ? session.entitlements : [];
  for (const raw of entitlements) {
    const entry = (raw ?? {}) as Json;
    if (entry.key !== "usage.monthly_pt") continue;
    const valueJson = (entry.value_json ?? {}) as Json;
    const limit = parseQuotaNumber(valueJson.limit);
    if (limit !== null && limit > 0) return limit;
  }
  return PERCH_MONTHLY_PT_FALLBACK;
}

function perchPt(usd: number | null): number {
  if (usd === null) return 0;
  return Math.max(0, usd * PERCH_PT_PER_USD);
}

function perchQuotaGroups(payload: Json, session: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const meter = parseQuotaRecord(payload.usageMeter) ?? {};
  const limit = perchMonthlyPtLimit(session);
  const monthlyPt = parseQuotaNumber(meter.monthlyPt);
  const monthlyUsd = parseQuotaNumber(meter.monthlyUsd);
  let monthlyUsed = Math.max(0, monthlyPt ?? 0);
  if (monthlyPt === null) monthlyUsed = Math.max(0, perchPt(monthlyUsd));
  const used = Math.min(monthlyUsed, limit);
  const remaining = Math.max(0, limit - used);
  const fraction = clampFraction(remaining / limit);
  groups.push({
    name: "monthly-allowance",
    displayName: "Monthly allowance",
    remainingFraction: fraction,
    remainingRequests: displayNumber(remaining),
    maxRequests: displayNumber(limit),
    usedRequests: displayNumber(used),
    resetTimeIso: null,
    resetInHuman: null,
    remainingLabel: `${formatFloat(remaining)} / ${formatFloat(limit)} PT`,
  });

  const rolling = parseQuotaRecord(meter.roostRolling);
  if (rolling && rolling.enabled === true) {
    const cap7d = parseQuotaNumber(rolling.window7dCapUsd);
    if (cap7d !== null && cap7d > 0) {
      groups.push(perchWindowGroup("fair-use-7d", "7-day fair use", parseQuotaNumber(rolling.window7dUsd), cap7d, parseResetIso(rolling.window7dNextFreedAt)));
    }
    const cap5h = parseQuotaNumber(rolling.window5hCapUsd);
    if (cap5h !== null && cap5h > 0) {
      groups.push(perchWindowGroup("fair-use-5h", "5-hour fair use", parseQuotaNumber(rolling.window5hUsd), cap5h, parseResetIso(rolling.window5hNextFreedAt)));
    }
  }

  const credits = parseQuotaNumber(payload.creditBalancePt);
  if (credits !== null && credits > 0) {
    const balance = Math.floor(credits);
    groups.push({
      name: "credits",
      displayName: "Credits",
      remainingFraction: 1,
      remainingRequests: displayNumber(balance),
      maxRequests: displayNumber(balance),
      usedRequests: 0,
      resetTimeIso: null,
      resetInHuman: null,
      remainingLabel: `${formatFloat(balance)} PT available`,
    });
  }
  return groups;
}

function perchWindowGroup(
  name: string,
  display: string,
  usedUsd: number | null,
  capUsd: number,
  resetIso: string | null
): QuotaGroupDisplay {
  const used = Math.max(0, usedUsd ?? 0);
  const cap = Math.max(0, capUsd);
  const remaining = Math.max(0, cap - used);
  return {
    name,
    displayName: display,
    remainingFraction: clampFraction(remaining / cap),
    remainingRequests: displayNumber(remaining),
    maxRequests: displayNumber(cap),
    usedRequests: displayNumber(used),
    resetTimeIso: resetIso,
    resetInHuman: formatTimeUntilResetIso(resetIso),
    remainingLabel: `$${formatFloat(remaining)} / $${formatFloat(cap)}`,
  };
}
