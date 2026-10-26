import { Effect } from "effect";
import { putQuota } from "@opendum/providers/quota/cache";
import {
  baseInfo,
  clampFraction,
  displayNumber,
  errorInfo,
  expiredInfo,
  formatFloat,
  resetIso,
  parseArray,
  parseNumber,
  parseRecord,
  parseString,
} from "@opendum/providers/quota/helpers";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "@opendum/providers/quota/types";
import { QuotaJson, quotaAttempt, quotaPayload, type Json } from "@opendum/providers/quota/fetchers/shared";

const WORKBUDDY_SUMMARY_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-summary";
const WORKBUDDY_FREE_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages";
const WORKBUDDY_PAID_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-paid-packages";
const WORKBUDDY_DOMAIN = "www.workbuddy.ai";
const WORKBUDDY_PAGE_SIZE = 50;

export function workbuddyQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const token = accessToken.trim();
  if (!token) {
    return Effect.succeed(expiredInfo("WorkBuddy access token is missing. Re-authenticate this account."));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Domain": WORKBUDDY_DOMAIN,
  };
  const userId = account.accountId?.trim() ?? "";
  if (userId) headers["X-User-Id"] = userId;

  return quotaPayload(ctx, account, forceRefresh, {
    cache: "workbuddy:resource-summary",
    method: "POST",
    url: WORKBUDDY_SUMMARY_URL,
    headers,
    body: {},
    label: "WorkBuddy",
    expiredMessage: "WorkBuddy session is invalid or expired. Re-authenticate this account.",
  }).pipe(
    Effect.flatMap((payload) => {
      if (!payload.ok) return Effect.succeed(payload.info);
      if (payload.data.code !== 0) {
        return Effect.succeed(
          errorInfo(`WorkBuddy quota request failed: ${payload.data.code} ${payload.data.msg ?? ""}`)
        );
      }
      const summary = parseRecord(payload.data.data) ?? {};
      const packages = parseArray(summary.Packages).map((raw) => (parseRecord(raw) ?? {}) as Json);
      return packageDetails(ctx, account, headers, forceRefresh, packages).pipe(
        Effect.flatMap((details) => {
          const groups = quotaGroups(packages, details);
          if (groups.length === 0) {
            return Effect.succeed(errorInfo("WorkBuddy quota response did not include usable quota data"));
          }
          return Effect.succeed(baseInfo("success", groups));
        })
      );
    })
  );
}

function quotaGroups(
  packages: Json[],
  details: Map<string, { packageName: string; cycleEndTime: string }>
): QuotaGroupDisplay[] {
  const groups: QuotaGroupDisplay[] = [];
  for (const pkg of packages) {
    const total = parseNumber(pkg.CycleTotalCapacity);
    let remaining = parseNumber(pkg.CycleRemainCapacity);
    let used = parseNumber(pkg.CycleUsedCapacity) ?? 0;
    if (total === null || remaining === null || total <= 0) continue;
    used = Math.min(Math.max(0, used), total);
    remaining = Math.max(0, Math.min(remaining, total));
    const fraction = clampFraction(remaining / total);
    const name = parseString(pkg.PackageCode) || "package";
    const detail = details.get(name);
    const display = displayOf(name, detail?.packageName ?? "");
    const resetValue = resetAt(detail?.cycleEndTime ?? "");
    groups.push({
      name,
      displayName: display,
      remainingFraction: fraction,
      remainingRequests: displayNumber(remaining),
      maxRequests: displayNumber(total),
      usedRequests: displayNumber(used),
      resetTimeIso: resetValue,
      resetInHuman: resetIso(resetValue),
      remainingLabel: `${formatFloat(remaining)} / ${formatFloat(total)} credits`,
    });
  }
  return groups;
}

function packageDetails(
  ctx: QuotaContext,
  account: QuotaAccount,
  headers: Record<string, string>,
  forceRefresh: boolean,
  packages: Json[]
): Effect.Effect<Map<string, { packageName: string; cycleEndTime: string }>> {
  const out = new Map<string, { packageName: string; cycleEndTime: string }>();
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    const code = parseString(pkg.PackageCode);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  if (codes.length === 0) return Effect.succeed(out);
  const targets = [
    { cache: "workbuddy:resource-free-packages", url: WORKBUDDY_FREE_URL },
    { cache: "workbuddy:resource-paid-packages", url: WORKBUDDY_PAID_URL },
  ];

  const loadTarget = (target: { cache: string; url: string }) =>
    quotaAttempt(ctx, account, forceRefresh, target.cache, "POST", target.url, headers, {
      PackageCodes: codes,
      PageNumber: 1,
      PageSize: WORKBUDDY_PAGE_SIZE,
    }).pipe(
      Effect.flatMap((attempt) => {
        if (!attempt.ok) return Effect.void;
        const { result } = attempt;
        const payload = QuotaJson.parse(result.raw);
        if (!payload || payload.code !== 0) return Effect.void;
        return putQuota(ctx, result).pipe(
          Effect.flatMap(() => {
            const data = parseRecord(payload.data) ?? {};
            for (const raw of parseArray(data.Accounts)) {
              const entry = parseRecord(raw);
              if (!entry) continue;
              const code = parseString(entry.PackageCode);
              if (!code || out.has(code)) continue;
              out.set(code, {
                packageName: parseString(entry.PackageName),
                cycleEndTime: parseString(entry.CycleEndTime),
              });
            }
            return Effect.void;
          })
        );
      })
    );

  return Effect.forEach(targets, loadTarget, { concurrency: 1, discard: true }).pipe(Effect.as(out));
}

function displayOf(packageCode: string, packageName: string): string {
  if (packageName.trim()) {
    const normalized = normalizePackage(packageName);
    return normalized || packageName;
  }
  if (packageCode.startsWith("TCACA_code_006")) return "Bonus Pack";
  if (packageCode.startsWith("TCACA_code_035")) return "Free Plan";
  const trimmed = stripSuffix(packageCode);
  if (trimmed) return trimmed;
  if (packageCode) return packageCode;
  return "package";
}

function normalizePackage(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "free plan subscription") return "Free Plan";
  if (lower === "bonus pack") return "Bonus Pack";
  return name.trim();
}

function stripSuffix(code: string): string {
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

function resetAt(cycleEndTime: string): string | null {
  const value = cycleEndTime.trim();
  if (!value) return null;
  const parsed = cycleTime(value);
  return parsed ? parsed.toISOString() : null;
}

function cycleTime(value: string): Date | null {
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
