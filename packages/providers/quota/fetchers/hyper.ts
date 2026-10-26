import { Effect } from "effect";
import { baseInfo, expiredInfo, parseNumber } from "../helpers.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaGroupDisplay } from "../types.js";
import { quotaPayload, type Json } from "./shared.js";

export function hyperQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  let apiKey: string;
  try {
    apiKey = ctx.decrypt(account.accessToken ?? "");
  } catch {
    return Effect.succeed(
      expiredInfo("API key is missing or invalid. Please reconnect this account.")
    );
  }
  return quotaPayload(ctx, account, forceRefresh, {
    cache: "hyper:credits",
    method: "GET",
    url: "https://hyper.charm.land/v1/credits",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, Accept: "application/json" },
    label: "Charm credits",
  }).pipe(
    Effect.map((payload) =>
      payload.ok ? baseInfo("success", hyperGroups(payload.data)) : payload.info
    )
  );
}

function hyperGroups(payload: Json): QuotaGroupDisplay[] {
  const balance = parseNumber(payload.balance);
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
