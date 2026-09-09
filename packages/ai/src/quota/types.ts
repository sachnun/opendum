import type { ProviderAccount } from "@opendum/database";

export interface QuotaGroupDisplay {
  name: string;
  displayName: string;
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  resetTimeIso: string | null;
  resetInHuman: string | null;
}

export interface AccountQuotaInfo {
  status: "success" | "error" | "expired";
  error?: string;
  groups: QuotaGroupDisplay[];
}

export type QuotaFetcher = (
  account: ProviderAccount,
  credentials?: string
) => Promise<AccountQuotaInfo>;
