export interface RateLimitRule {
  target: string;
  targetType: string;
  perMinute?: number | null;
  perHour?: number | null;
  perDay?: number | null;
}

export interface AuthResult {
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
}

export interface ModelAccess {
  mode: string;
  models: string[];
  roamingEnabled: boolean;
}

export interface AccountAccess {
  mode: string;
  accounts: string[];
}

export interface ModelValidationResult {
  valid: boolean;
  provider: string | null;
  model: string;
  error: string;
  param: string;
  code: string;
}

export interface AccountModelAvailability {
  activeProviders: Set<string>;
  accountCountByProvider: Map<string, number>;
  disabledCountByProviderModel: Map<string, number>;
  activeAccountIDsByProvider: Map<string, string[]>;
  accountTierByID: Map<string, string>;
  authlessProviderModels: Map<string, Set<string>>;
  sharedAccountCountByProvider: Map<string, number>;
  sharedDisabledCountByProviderModel: Map<string, number>;
  sharedAccountTiersByProvider: Map<string, string[]>;
}

export interface CacheValue {
  valid: boolean;
  userId: string;
  apiKeyId: string;
  modelAccessMode: string;
  modelAccessList: string[];
  accountAccessMode: string;
  accountAccessList: string[];
  roamingEnabled: boolean;
  expiresAtMs: number | null;
  updatedAtMicros: number | null;
  rateLimitRules: RateLimitRule[];
  error: string;
}

export interface DisabledModelsCacheValue {
  models: string[];
}

export const AUTH_NONE: AuthResult = {
  valid: false,
  userId: "",
  apiKeyId: "",
  modelAccessMode: "all",
  modelAccessList: [],
  accountAccessMode: "all",
  accountAccessList: [],
  roamingEnabled: false,
  rateLimitRules: [],
  error: "",
};

export function validAuthResult(overrides: Partial<AuthResult> = {}): AuthResult {
  return { ...AUTH_NONE, valid: true, ...overrides };
}

export function invalidAuthResult(error: string): AuthResult {
  return { ...AUTH_NONE, error };
}
