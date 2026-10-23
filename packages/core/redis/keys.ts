export const API_KEY_VALIDATION_PREFIX = "opendum:api-key:validation";
export const API_KEY_LAST_USED_PREFIX = "opendum:api-key:last-used";
export const USER_DISABLED_MODELS_PREFIX = "opendum:user:disabled-models";
export const REFRESH_FAIL_COUNT_PREFIX = "opendum:provider-account:refresh-fail-count";
export const ACCOUNT_AFFINITY_PREFIX = "opendum:account-affinity";
export const MODEL_SATURATION_PREFIX = "opendum:model-saturation";
export const ANALYTICS_VERSION_PREFIX = "opendum:analytics:v1:version";
export const ANALYTICS_VERSION_BUMP_PREFIX = "opendum:analytics:v1:version-bump";

export function apiKeyValidationKey(keyHash: string): string {
  return `${API_KEY_VALIDATION_PREFIX}:${keyHash}`;
}

export function apiKeyLastUsedKey(apiKeyId: string): string {
  return `${API_KEY_LAST_USED_PREFIX}:${apiKeyId}`;
}

export function disabledKey(userId: string): string {
  return `${USER_DISABLED_MODELS_PREFIX}:${userId}`;
}

export function refreshFailCountKey(accountId: string): string {
  return `${REFRESH_FAIL_COUNT_PREFIX}:${accountId}`;
}

export function accountAffinityKey(userId: string, scope = ""): string {
  const normalized = scope.trim();
  return normalized
    ? `${ACCOUNT_AFFINITY_PREFIX}:${normalized}:${userId}`
    : `${ACCOUNT_AFFINITY_PREFIX}:${userId}`;
}

export function modelSaturationKey(provider: string, model: string): string {
  return `${MODEL_SATURATION_PREFIX}:${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
}

export function analyticsVersionKey(userId: string): string {
  return `${ANALYTICS_VERSION_PREFIX}:${userId}`;
}

export function analyticsVersionBumpKey(userId: string): string {
  return `${ANALYTICS_VERSION_BUMP_PREFIX}:${userId}`;
}
