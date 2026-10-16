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
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaFetcher } from "./types.js";

const FETCHERS: QuotaFetcher[] = [
  {
    provider: "openrouter",
    withoutToken: true,
    fetch: (ctx, account, _accessToken, forceRefresh) => fetchOpenRouterQuota(ctx, account, forceRefresh),
  },
  {
    provider: "antigravity",
    withoutToken: false,
    fetch: (ctx, account, accessToken, forceRefresh) => fetchAntigravityQuota(ctx, account, accessToken, forceRefresh),
  },
  {
    provider: "codex",
    withoutToken: false,
    fetch: (ctx, account, accessToken, forceRefresh) => fetchCodexQuota(ctx, account, accessToken, forceRefresh),
  },
  {
    provider: "kiro",
    withoutToken: false,
    fetch: (ctx, account, accessToken, forceRefresh) => fetchKiroQuota(ctx, account, accessToken, forceRefresh),
  },
  {
    provider: "perch",
    withoutToken: false,
    fetch: (ctx, account, accessToken, forceRefresh) => fetchPerchQuota(ctx, account, accessToken, forceRefresh),
  },
  {
    provider: "zenmux",
    withoutToken: true,
    fetch: (ctx, account, _accessToken, forceRefresh) => fetchZenmuxQuota(ctx, account, forceRefresh),
  },
  {
    provider: "hyper",
    withoutToken: true,
    fetch: (ctx, account, _accessToken, forceRefresh) => fetchHyperQuota(ctx, account, forceRefresh),
  },
  {
    provider: "workbuddy",
    withoutToken: false,
    fetch: (ctx, account, accessToken, forceRefresh) => fetchWorkbuddyQuota(ctx, account, accessToken, forceRefresh),
  },
];

/**
 * Registry of provider quota fetchers. Owns provider lookup, the set of
 * providers that need no access token, and the shared credential-resolution
 * flow: credential failures are represented as an `expired` quota result
 * rather than a failure so callers can render a re-authenticate prompt.
 */
export class Quotas {
  private readonly fetchers: Map<string, QuotaFetcher>;

  constructor(fetchers: QuotaFetcher[] = FETCHERS) {
    this.fetchers = new Map(fetchers.map((fetcher) => [fetcher.provider, fetcher]));
  }

  isSupported(provider: string): boolean {
    return this.fetchers.has(provider);
  }

  withoutToken(): Set<string> {
    const providers = new Set<string>();
    for (const fetcher of this.fetchers.values()) {
      if (fetcher.withoutToken) providers.add(fetcher.provider);
    }
    return providers;
  }

  fetch(ctx: QuotaContext, account: QuotaAccount, forceRefresh: boolean): Effect.Effect<AccountQuotaInfo> {
    const fetcher = this.fetchers.get(account.provider);
    if (!fetcher) {
      return Effect.succeed({
        status: "error",
        error: `provider ${account.provider} is not supported for quota`,
        groups: [],
      });
    }
    if (fetcher.withoutToken) return fetcher.fetch(ctx, account, "", forceRefresh);
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
      return yield* fetcher.fetch(ctx, account, credentials.value, forceRefresh);
    });
  }
}

const defaultRegistry = new Quotas();

export function isQuota(provider: string): boolean {
  return defaultRegistry.isSupported(provider);
}

export function withoutToken(): Set<string> {
  return defaultRegistry.withoutToken();
}

export function fetchQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Effect.Effect<AccountQuotaInfo> {
  return defaultRegistry.fetch(ctx, account, forceRefresh);
}
