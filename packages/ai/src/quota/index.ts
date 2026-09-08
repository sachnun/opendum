import type { ProviderAccount } from "@opendum/database";
import type { AccountQuotaInfo, QuotaFetcher } from "./types.js";
import { fetchAntigravityQuota } from "./antigravity.js";
import { fetchPerchQuota } from "./perch.js";

export * from "./types.js";
export * from "./antigravity.js";
export * from "./perch.js";

const fetchers: Record<string, QuotaFetcher> = {
  antigravity: fetchAntigravityQuota,
  perch: fetchPerchQuota,
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
