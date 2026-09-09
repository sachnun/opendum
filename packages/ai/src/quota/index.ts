import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaFetcher } from "./types.js";
import { fetchAntigravityQuota } from "./antigravity.js";
import { fetchPerchQuota } from "./perch.js";
import { fetchCodexQuota } from "./codex.js";
import { fetchKiroQuota } from "./kiro.js";
import { fetchOpenRouterQuota } from "./openrouter.js";
import { fetchZenmuxQuota } from "./zenmux.js";
import { fetchHyperQuota } from "./hyper.js";

export * from "./types.js";
export * from "./antigravity.js";
export * from "./perch.js";
export * from "./codex.js";
export * from "./kiro.js";
export * from "./openrouter.js";
export * from "./zenmux.js";
export * from "./hyper.js";

const fetchers: Record<string, QuotaFetcher> = {
  antigravity: fetchAntigravityQuota,
  perch: fetchPerchQuota,
  codex: fetchCodexQuota,
  kiro: fetchKiroQuota,
  openrouter: fetchOpenRouterQuota,
  zenmux: fetchZenmuxQuota,
  hyper: fetchHyperQuota,
};

export async function fetchAccountQuota(
  account: ProviderAccount,
  credentials?: string
): Promise<AccountQuotaInfo> {
  const fetcher = fetchers[account.provider];
  if (!fetcher) {
    return {
      status: "success",
      groups: [],
    };
  }

  return await fetcher(account, credentials);
}
