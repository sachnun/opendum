import { getQuotaJson, putQuotaCache } from "#quota/lib/cache.ts";
import { baseQuotaInfo, clampFraction, displayNumber, errorQuotaInfo, expiredQuotaInfo, formatFloat, formatTimeUntilResetIso, parseQuotaArray, parseQuotaNumber, parseQuotaRecord, parseQuotaString } from "#quota/lib/helpers.ts";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "#quota/types.ts";
import type { Json } from "#quota/providers/common.ts";

export const provider: QuotaProvider = {
  name: "workbuddy",
  fetch: (ctx, account, token, forceRefresh) => fetchWorkbuddyQuota(ctx, account, token, forceRefresh),
};

const WORKBUDDY_SUMMARY_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-summary";
const WORKBUDDY_FREE_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-free-packages";
const WORKBUDDY_PAID_URL = "https://www.workbuddy.ai/billing/meter/get-user-resource-paid-packages";
const WORKBUDDY_DOMAIN = "www.workbuddy.ai";
const WORKBUDDY_PAGE_SIZE = 50;

async function fetchWorkbuddyQuota(
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
