export type AuthMethod =
  | "oauth_redirect"
  | "device_code"
  | "api_key"
  | "api_key_with_account_id"
  | "chatgpt_session";

export type ProviderCategory = "oauth" | "api_key";

export type ProviderSpec = {
  readonly key: string;
  readonly slug: string;
  readonly label: string;
  readonly category: ProviderCategory;
  readonly showTier: boolean;
  readonly authMethods: ReadonlyArray<AuthMethod>;
  readonly supportsQuota: boolean;
  readonly displayOrder: number;
  readonly navOrder?: number;
  readonly apiKeyPortalUrl?: string;
  readonly apiKeyPlaceholder?: string;
  readonly accountIdLabel?: string;
  readonly accountIdPlaceholder?: string;
  readonly callbackPlaceholder?: string;
};

export type CompatSpec = {
  readonly name: string;
  readonly baseUrl: string;
  readonly fallbackBaseUrl?: string;
};

export type ProviderEntry = {
  readonly spec?: ProviderSpec;
  readonly compat?: CompatSpec;
};
