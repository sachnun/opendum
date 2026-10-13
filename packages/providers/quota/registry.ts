import { Effect } from "effect";
import {
  fetchAntigravityQuota,
  fetchCodexQuota,
  fetchHyperQuota,
  fetchKiroQuota,
  fetchOpenRouterQuota,
  fetchWorkbuddyQuota,
  fetchZenmuxQuota,
} from "./fetchers/index.js";
import { fetchPerchQuota } from "./perch.js";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext } from "./types.js";

type RegistryFetcher = (
  ctx: QuotaContext,
  account: QuotaAccount,
  token: string,
  forceRefresh: boolean
) => Effect.Effect<AccountQuotaInfo>;

const PROVIDERS_WITHOUT_TOKEN = new Set(["openrouter", "hyper"]);

const REGISTRY: Record<string, RegistryFetcher> = {
  openrouter: (ctx, account, _token, forceRefresh) => fetchOpenRouterQuota(ctx, account, forceRefresh),
  antigravity: (ctx, account, token, forceRefresh) => fetchAntigravityQuota(ctx, account, token, forceRefresh),
  codex: (ctx, account, token, forceRefresh) => fetchCodexQuota(ctx, account, token, forceRefresh),
  kiro: (ctx, account, token, forceRefresh) => fetchKiroQuota(ctx, account, token, forceRefresh),
  perch: (ctx, account, token, forceRefresh) => fetchPerchQuota(ctx, account, token, forceRefresh),
  zenmux: (ctx, account, _token, forceRefresh) => fetchZenmuxQuota(ctx, account, forceRefresh),
  hyper: (ctx, account, _token, forceRefresh) => fetchHyperQuota(ctx, account, forceRefresh),
  workbuddy: (ctx, account, token, forceRefresh) => fetchWorkbuddyQuota(ctx, account, token, forceRefresh),
};

export function isQuotaProvider(provider: string): boolean {
  return provider in REGISTRY;
}

export function quotaProvidersWithoutToken(): Set<string> {
  return PROVIDERS_WITHOUT_TOKEN;
}

/**
 * Resolves a quota fetcher and its credentials. Credential failures are
 * represented as an `expired` quota result rather than a failure so callers can
 * render a re-authenticate prompt.
 */
export function fetchAccountQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  const fetcher = REGISTRY[account.provider];
  if (!fetcher) {
    return Effect.succeed({
      status: "error",
      error: `provider ${account.provider} is not supported for quota`,
      groups: [],
    });
  }
  if (PROVIDERS_WITHOUT_TOKEN.has(account.provider)) {
    return fetcher(ctx, account, "", forceRefresh);
  }
  return Effect.gen(function* () {
    const credentials = yield* Effect.tryPromise({
      try: () => ctx.getCredentials(account),
      catch: (cause) => cause,
    }).pipe(Effect.option);
    if (credentials._tag === "None") {
      return {
        status: "expired",
        error: "Token expired - please re-authenticate",
        groups: [],
      } satisfies AccountQuotaInfo;
    }
    return yield* fetcher(ctx, account, credentials.value, forceRefresh);
  });
}
