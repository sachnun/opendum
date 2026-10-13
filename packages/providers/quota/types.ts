export type QuotaGroupDisplay = {
  name: string;
  displayName: string;
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  resetTimeIso: string | null;
  resetInHuman: string | null;
  remainingLabel?: string | null;
};

export type AccountQuotaInfo = {
  status: string;
  error: string;
  groups: QuotaGroupDisplay[];
};

export type QuotaAccount = {
  id: string;
  userId: string;
  provider: string;
  projectId?: string | null;
  accountId?: string | null;
  tier?: string | null;
  accessToken?: string;
};

export type QuotaFetcher = (
  account: QuotaAccount,
  accessToken: string,
  forceRefresh: boolean
) => Promise<AccountQuotaInfo>;

export type QuotaJournal = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
};

export type QuotaFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type QuotaContext = {
  fetch: QuotaFetch;
  journal: QuotaJournal | null;
  decrypt: (value: string) => string;
  getCredentials: (account: QuotaAccount) => Promise<string>;
};
