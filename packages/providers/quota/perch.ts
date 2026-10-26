import { Effect } from "effect";
import { quotaPayload } from "@opendum/providers/quota/fetchers/shared";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  expiredInfo,
  formatFloat,
  resetIso,
  parseNumber,
  parseRecord,
  isoOf,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";

type Json = Record<string, unknown>;

const PERCH_ACCOUNT_URL = "https://app.perchai.app/api/perchai/account";
const MONTHLY_FALLBACK = 20000;
const PT_PER_USD = 1000;

export function fetchQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const token = accessToken.trim();
  if (!token) {
    return Effect.succeed(expiredInfo("Perch access token is missing. Re-authenticate this account."));
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  return quotaPayload(ctx, account, forceRefresh, {
    cache: "perch:account",
    method: "GET",
    url: PERCH_ACCOUNT_URL,
    headers,
    label: "Perch account",
    expiredMessage: "Perch session is invalid or expired. Re-authenticate this account.",
  }).pipe(
    Effect.map((payload) => {
      if (!payload.ok) return payload.info;
      if (payload.data.ok !== true) {
        return errorInfo("Perch account request was rejected. Re-authenticate this account.");
      }
      const session = parseRecord(payload.data.session) ?? {};
      if (session.tierSelectionRequired === true) {
        return expiredInfo("Perch account has no active plan yet. Re-authenticate to select the Starter plan.");
      }
      const groups = quotaGroups(payload.data, session);
      if (groups.length === 0) return errorInfo("Perch account has no usage or allowance data");
      return baseInfo("success", groups);
    })
  );
}

function monthlyLimit(session: Json): number {
  const entitlements = Array.isArray(session.entitlements) ? session.entitlements : [];
  for (const raw of entitlements) {
    const entry = (raw ?? {}) as Json;
    if (entry.key !== "usage.monthly_pt") continue;
    const valueJson = (entry.value_json ?? {}) as Json;
    const limit = parseNumber(valueJson.limit);
    if (limit !== null && limit > 0) return limit;
  }
  return MONTHLY_FALLBACK;
}

function perchPt(usd: number | null): number {
  if (usd === null) return 0;
  return Math.max(0, usd * PT_PER_USD);
}

function quotaGroups(payload: Json, session: Json): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  const meter = parseRecord(payload.usageMeter) ?? {};
  const limit = monthlyLimit(session);
  const monthlyPt = parseNumber(meter.monthlyPt);
  const monthlyUsd = parseNumber(meter.monthlyUsd);
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

  const rolling = parseRecord(meter.roostRolling);
  if (rolling && rolling.enabled === true) {
    const cap7d = parseNumber(rolling.window7dCapUsd);
    if (cap7d !== null && cap7d > 0) {
      groups.push(windowGroup("fair-use-7d", "7-day fair use", parseNumber(rolling.window7dUsd), cap7d, isoOf(rolling.window7dNextFreedAt)));
    }
    const cap5h = parseNumber(rolling.window5hCapUsd);
    if (cap5h !== null && cap5h > 0) {
      groups.push(windowGroup("fair-use-5h", "5-hour fair use", parseNumber(rolling.window5hUsd), cap5h, isoOf(rolling.window5hNextFreedAt)));
    }
  }

  const credits = parseNumber(payload.creditBalancePt);
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

function windowGroup(
  name: string,
  display: string,
  usedUsd: number | null,
  capUsd: number,
  resetValue: string | null
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
    resetTimeIso: resetValue,
    resetInHuman: resetIso(resetValue),
    remainingLabel: `$${formatFloat(remaining)} / $${formatFloat(cap)}`,
  };
}
