import type { ProviderAccount } from "../../db/index.js";
import type { HttpClient, RequestContext } from "../../providers/types.js";
import { getQuotaJSON, putQuotaJSONCache, parseQuotaNumber, clampFraction, displayNumber, formatFloat, formatTimeUntilResetISO, type AccountQuotaInfo, type QuotaGroupDisplay, baseQuotaInfo, errorQuotaInfo, expiredQuotaInfo } from "./quota.js";
import type { QuotaFetcherDeps } from "./quota-fetchers.js";

const commandCodeAPIBaseURL = "https://api.commandcode.ai";

const commandCodePlanAllowance: Record<string, { label: string; allowUSD: number }> = {
  "individual-go": { label: "go", allowUSD: 10 },
  "individual-max-10x": { label: "max-10x", allowUSD: 150 },
  "individual-max-20x": { label: "max-20x", allowUSD: 300 },
  "team-pro": { label: "team-pro", allowUSD: 40 },
};

export function commandCodeTierFromPlanID(planID: string): [string, number, boolean] {
  const cleaned = planID.trim().toLowerCase();
  if (cleaned === "") return ["", 0, false];
  const entry = commandCodePlanAllowance[cleaned];
  if (!entry) return [cleaned, 0, false];
  return [entry.label, entry.allowUSD, true];
}

interface CommandCodeWhoami {
  success?: unknown;
  user?: { id?: unknown; name?: unknown; userName?: unknown } | null;
  error?: { message?: unknown } | null;
}

interface CommandCodeSubscriptionResponse {
  success?: unknown;
  data?: {
    id?: unknown;
    status?: unknown;
    planId?: unknown;
    currentPeriodStart?: unknown;
    currentPeriodEnd?: unknown;
    cancelAtPeriodEnd?: unknown;
  } | null;
  error?: { message?: unknown } | null;
}

interface CommandCodeWindowLimit {
  used?: unknown;
  cap?: unknown;
  resetAt?: unknown;
}

interface CommandCodeCreditsResponse {
  credits?: {
    belowThreshold?: unknown;
    creditThreshold?: unknown;
    monthlyCredits?: unknown;
    purchasedCredits?: unknown;
    freeCredits?: unknown;
  } | null;
  windowLimits?: {
    limited?: unknown;
    exceeded?: unknown;
    fiveHour?: CommandCodeWindowLimit | null;
    weekly?: CommandCodeWindowLimit | null;
  } | null;
  error?: { message?: unknown } | null;
}

interface CommandCodeUsageSummary {
  totalCount?: unknown;
  totalCost?: unknown;
  totalTokens?: unknown;
  totalCredits?: unknown;
  totalFreeCredits?: unknown;
  totalMonthlyCredits?: unknown;
}

function commandCodeHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: "Bearer " + apiKey,
    accept: "application/json",
    "x-command-code-version": "0.38.7",
    "x-cli-environment": "production",
    "x-project-slug": "command-code",
  };
}

async function commandCodeGet(deps: QuotaFetcherDeps, account: ProviderAccount, forceRefresh: boolean, cacheName: string, target: string, headers: Record<string, string>): Promise<ReturnType<typeof getQuotaJSON>> {
  return getQuotaJSON(deps.client, deps.ctx, deps.redis, account, forceRefresh, cacheName, "GET", target, headers, null);
}

export async function fetchCommandCodeQuota(deps: QuotaFetcherDeps, account: ProviderAccount, credentials: string, forceRefresh: boolean): Promise<AccountQuotaInfo> {
  const apiKey = credentials.trim();
  if (apiKey === "") {
    return expiredQuotaInfo("Command Code API key is missing. Reconnect this account.");
  }

  const base = commandCodeAPIBaseURL;
  const headersForCaller = commandCodeHeaders(apiKey);

  // Step 1 — whoami
  const whoamiResult = await commandCodeGet(deps, account, forceRefresh, "commandcode:whoami", base + "/alpha/whoami", headersForCaller);
  if (whoamiResult.status === 401 || whoamiResult.status === 403) {
    return expiredQuotaInfo("Command Code API key is invalid or revoked. Please reconnect this account.");
  }
  if (whoamiResult.status < 200 || whoamiResult.status >= 300) {
    return errorQuotaInfo(`Command Code whoami returned HTTP ${whoamiResult.status}`);
  }
  let whoami: CommandCodeWhoami;
  try {
    whoami = JSON.parse(whoamiResult.raw) as CommandCodeWhoami;
  } catch {
    return errorQuotaInfo("Command Code whoami response was not valid JSON");
  }
  if (!whoami.success || !whoami.user) {
    return expiredQuotaInfo("Command Code whoami did not confirm the account. Please reconnect this account.");
  }
  await putQuotaJSONCache(deps.redis, whoamiResult, whoamiResult.headers);

  // Step 2 — subscription
  const subscriptionResult = await commandCodeGet(deps, account, forceRefresh, "commandcode:subscription", base + "/alpha/billing/subscriptions", headersForCaller);
  if (subscriptionResult.status < 200 || subscriptionResult.status >= 300) {
    return errorQuotaInfo(`Command Code subscription returned HTTP ${subscriptionResult.status}`);
  }
  let subscription: CommandCodeSubscriptionResponse;
  try {
    subscription = JSON.parse(subscriptionResult.raw) as CommandCodeSubscriptionResponse;
  } catch {
    return errorQuotaInfo("Command Code subscription response was not valid JSON");
  }
  if (!subscription.success || !subscription.data) {
    return errorQuotaInfo("Command Code subscription response did not include subscription data");
  }
  const subStatus = typeof subscription.data.status === "string" ? subscription.data.status.trim() : "";
  if (subStatus.toLowerCase() !== "active") {
    return expiredQuotaInfo(`Command Code subscription status is "${subStatus}". Renew or upgrade at commandcode.ai/billing.`);
  }
  await putQuotaJSONCache(deps.redis, subscriptionResult, subscriptionResult.headers);

  const planID = typeof subscription.data.planId === "string" ? subscription.data.planId : "";
  const [tierLabel, allowance, tierKnown] = commandCodeTierFromPlanID(planID);

  // Step 3 — credits
  const creditsResult = await commandCodeGet(deps, account, forceRefresh, "commandcode:billing-credits", base + "/alpha/billing/credits", headersForCaller);
  if (creditsResult.status < 200 || creditsResult.status >= 300) {
    return errorQuotaInfo(`Command Code credits returned HTTP ${creditsResult.status}`);
  }
  let credits: CommandCodeCreditsResponse;
  try {
    credits = JSON.parse(creditsResult.raw) as CommandCodeCreditsResponse;
  } catch {
    return errorQuotaInfo("Command Code credits response was not valid JSON or did not include a credits object");
  }
  if (!credits.credits) {
    return errorQuotaInfo("Command Code credits response was not valid JSON or did not include a credits object");
  }
  await putQuotaJSONCache(deps.redis, creditsResult, creditsResult.headers);

  let remainingEntitlement = 0;
  if (credits.credits.monthlyCredits !== undefined) remainingEntitlement += numberValue(credits.credits.monthlyCredits);
  if (credits.credits.purchasedCredits !== undefined) remainingEntitlement += numberValue(credits.credits.purchasedCredits);
  if (credits.credits.freeCredits !== undefined) remainingEntitlement += numberValue(credits.credits.freeCredits);
  if (remainingEntitlement < 0) remainingEntitlement = 0;

  // Step 4 — usage summary
  let usageURL = base + "/alpha/usage/summary";
  const since = typeof subscription.data.currentPeriodStart === "string" ? subscription.data.currentPeriodStart.trim() : "";
  if (since !== "") {
    usageURL = usageURL + "?since=" + encodeURIComponent(since);
  }
  const usageResult = await commandCodeGet(deps, account, forceRefresh, "commandcode:usage-summary", usageURL, headersForCaller);
  if (usageResult.status < 200 || usageResult.status >= 300) {
    return errorQuotaInfo(`Command Code usage returned HTTP ${usageResult.status}`);
  }
  let usage: CommandCodeUsageSummary;
  try {
    usage = JSON.parse(usageResult.raw) as CommandCodeUsageSummary;
  } catch {
    return errorQuotaInfo("Command Code usage response was not valid JSON");
  }
  const totalCost = numberValue(usage.totalCost);
  if (totalCost < 0) {
    return errorQuotaInfo("Command Code usage response carried a negative total cost");
  }
  await putQuotaJSONCache(deps.redis, usageResult, usageResult.headers);

  let denominator = allowance;
  if (denominator <= 0) {
    denominator = remainingEntitlement + totalCost;
  }
  const remainingUSD = Math.max(0, denominator - totalCost);
  let fraction = 1.0;
  if (denominator > 0) {
    fraction = clampFraction(remainingUSD / denominator);
  }

  let displayName = `Plan balance (${tierLabel})`;
  if (!tierKnown) {
    displayName = `Plan balance (unknown — ${planID.trim()})`;
  } else if (tierLabel !== "go") {
    displayName = `Plan balance (${tierLabel} — tier mismatch)`;
  }

  let resetISO: string | null = null;
  let resetHuman: string | null = null;
  const periodEnd = typeof subscription.data.currentPeriodEnd === "string" ? subscription.data.currentPeriodEnd.trim() : "";
  if (periodEnd !== "") {
    resetISO = periodEnd;
    resetHuman = formatTimeUntilResetISO(resetISO);
  }

  let remainingLabel = `$${Math.max(0, remainingEntitlement).toFixed(4)} / $${denominator.toFixed(2)}`;
  if (!tierKnown) {
    remainingLabel = `$${Math.max(0, remainingEntitlement).toFixed(4)} remaining`;
  }

  let confidence = "high";
  if (!tierKnown) confidence = "medium";
  else if (tierLabel !== "go") confidence = "medium";

  const group: QuotaGroupDisplay = {
    name: "command-code-plan",
    displayName,
    models: [],
    remainingFraction: fraction,
    remainingRequests: displayNumber(remainingUSD),
    maxRequests: displayNumber(denominator),
    usedRequests: displayNumber(totalCost),
    resetTimeIso: resetISO,
    resetInHuman: resetHuman,
    percentUsed: denominator > 0 ? Math.round(clampFraction(totalCost / denominator) * 100) : 0,
    isExhausted: remainingUSD <= 0.0001,
    isEstimated: false,
    confidence,
    remainingLabel,
  };

  const groups: QuotaGroupDisplay[] = [group];

  if (credits.windowLimits) {
    if (credits.windowLimits.fiveHour) {
      const cap = numberValue(credits.windowLimits.fiveHour.cap);
      if (cap > 0) {
        groups.push(buildWindowLimitGroup("five-hour", "5-Hour Window", credits.windowLimits.fiveHour));
      }
    }
    if (credits.windowLimits.weekly) {
      const cap = numberValue(credits.windowLimits.weekly.cap);
      if (cap > 0) {
        groups.push(buildWindowLimitGroup("weekly", "7-Day Window", credits.windowLimits.weekly));
      }
    }
  }

  return baseQuotaInfo("success", groups, "");
}

function buildWindowLimitGroup(name: string, display: string, w: CommandCodeWindowLimit): QuotaGroupDisplay {
  const used = numberValue(w.used);
  const cap = numberValue(w.cap);
  const remaining = Math.max(0, cap - used);
  const fraction = clampFraction(remaining / cap);
  const resetAt = typeof w.resetAt === "string" ? w.resetAt : "";
  const remainingLabel = `${formatFloat(remaining)} / ${formatFloat(cap)} requests`;
  return {
    name,
    displayName: display,
    models: [],
    remainingFraction: fraction,
    remainingRequests: displayNumber(remaining),
    maxRequests: displayNumber(cap),
    usedRequests: displayNumber(used),
    resetTimeIso: resetAt,
    resetInHuman: formatTimeUntilResetISO(resetAt),
    percentUsed: Math.round(clampFraction(used / cap) * 100),
    isExhausted: fraction <= 0,
    isEstimated: false,
    confidence: "high",
    remainingLabel,
  };
}

function numberValue(value: unknown): number {
  const [parsed, ok] = parseQuotaNumber(value);
  return ok ? parsed : 0;
}
