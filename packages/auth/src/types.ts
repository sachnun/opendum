export type RateLimitRule = {
  target: string;
  targetType: string;
  perMinute: number | null;
  perHour: number | null;
  perDay: number | null;
};

export type AuthResult = {
  valid: boolean;
  userId: string;
  apiKeyId: string;
  modelAccessMode: string;
  modelAccessList: string[];
  accountAccessMode: string;
  accountAccessList: string[];
  roamingEnabled: boolean;
  rateLimitRules: RateLimitRule[];
  error: string;
};

export type ModelAccess = {
  mode: string;
  models: string[];
  roamingEnabled: boolean;
};

export type AccountAccess = {
  mode: string;
  accounts: string[];
};

export type ModelValidationResult = {
  valid: boolean;
  provider: string | null;
  model: string;
  alias: string;
  vision: boolean | null;
  error: string;
  param: string;
  code: string;
};

export type AccountModelAvailability = {
  activeProviders: Set<string>;
  accountCountByProvider: Map<string, number>;
  disabledCountByProviderModel: Map<string, number>;
  activeAccountIdsByProvider: Map<string, string[]>;
  accountTierById: Map<string, string>;
  authlessProviderModels: Map<string, Set<string>>;
  customProviderModels: Map<string, Set<string>>;
  customProviderStandaloneModels: Map<string, string[]>;
  sharedAccountCountByProvider: Map<string, number>;
  sharedDisabledCountByProviderModel: Map<string, number>;
  sharedAccountTiersByProvider: Map<string, string[]>;
};

export function emptyAuthResult(error = ""): AuthResult {
  return {
    valid: false,
    userId: "",
    apiKeyId: "",
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    rateLimitRules: [],
    error,
  };
}

export function emptyAvailability(): AccountModelAvailability {
  return {
    activeProviders: new Set(),
    accountCountByProvider: new Map(),
    disabledCountByProviderModel: new Map(),
    activeAccountIdsByProvider: new Map(),
    accountTierById: new Map(),
    authlessProviderModels: new Map(),
    customProviderModels: new Map(),
    customProviderStandaloneModels: new Map(),
    sharedAccountCountByProvider: new Map(),
    sharedDisabledCountByProviderModel: new Map(),
    sharedAccountTiersByProvider: new Map(),
  };
}
