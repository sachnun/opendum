import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaProvider } from "#quota/types.ts";

const PROVIDERS = new Map<string, QuotaProvider>();

export function registerQuotaProviders(providers: QuotaProvider[]): void {
  for (const provider of providers) PROVIDERS.set(provider.name, provider);
}

export function isQuotaProvider(provider: string): boolean {
  return PROVIDERS.has(provider);
}

export function quotaProvidersWithoutToken(): Set<string> {
  const names = new Set<string>();
  for (const provider of PROVIDERS.values()) {
    if (provider.needsToken === false) names.add(provider.name);
  }
  return names;
}

export async function fetchAccountQuota(
  ctx: QuotaContext,
  account: QuotaAccount,
  forceRefresh: boolean
): Promise<AccountQuotaInfo> {
  const provider = PROVIDERS.get(account.provider);
  if (!provider) {
    return { status: "error", error: `provider ${account.provider} is not supported for quota`, groups: [] };
  }
  if (provider.needsToken === false) {
    return provider.fetch(ctx, account, "", forceRefresh);
  }
  let credentials: string;
  try {
    credentials = await ctx.getCredentials(account);
  } catch {
    return { status: "expired", error: "Token expired - please re-authenticate", groups: [] };
  }
  return provider.fetch(ctx, account, credentials, forceRefresh);
}
