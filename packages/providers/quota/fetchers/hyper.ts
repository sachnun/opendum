import { Effect } from "effect";
import {
  baseQuotaInfo,
  errorQuotaInfo,
  expiredQuotaInfo,
  parseQuotaNumber,
} from "../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "../types.js";
import { fetchJsonData, type Json } from "./shared.js";

export function fetchHyperQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return Effect.succeed(
      expiredQuotaInfo("API key is missing or invalid. Please reconnect this account.")
    );
  }
  return fetchJsonData(
    ctx,
    account,
    forceRefresh,
    "hyper:credits",
    "GET",
    "https://hyper.charm.land/v1/credits",
    { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
    null
  ).pipe(
    Effect.map(({ data, error }) => {
      if (error || !data) return errorQuotaInfo(error ?? "Charm credits request failed");
      return baseQuotaInfo("success", hyperGroups(data));
    })
  );
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
