import { baseQuotaInfo, errorQuotaInfo, expiredQuotaInfo, parseQuotaNumber } from "#quota/lib/helpers.ts";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay, QuotaProvider } from "#quota/types.ts";
import { fetchJsonData, type Json } from "#quota/providers/common.ts";

export const provider: QuotaProvider = {
  name: "hyper",
  needsToken: false,
  fetch: (ctx, account, _token, forceRefresh) => fetchHyperQuota(ctx, account, forceRefresh),
};

async function fetchHyperQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.");
  }
  const { data, error } = await fetchJsonData(
    ctx, account, forceRefresh, "hyper:credits", "GET", "https://hyper.charm.land/v1/credits",
    { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" }, null
  );
  if (error || !data) return errorQuotaInfo(error ?? "Charm credits request failed");
  return baseQuotaInfo("success", hyperGroups(data));
}

function hyperGroups(payload: Json): QuotaGroupDisplay[] {
  const balance = parseQuotaNumber(payload.balance);
  if (balance === null) {
    return [{
      name: "account-balance", displayName: "Balance", remainingFraction: 1, remainingRequests: 1,
      maxRequests: 1, usedRequests: 0, resetTimeIso: null, resetInHuman: null, remainingLabel: "active",
    }];
  }
  const usd = balance * 0.05;
  return [{
    name: "account-balance", displayName: "Balance", remainingFraction: 1,
    remainingRequests: usd, maxRequests: usd, usedRequests: 0, resetTimeIso: null, resetInHuman: null,
    remainingLabel: `$${usd.toFixed(2)}`,
  }];
}
