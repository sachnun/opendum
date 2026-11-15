export const VALIDATION_PREFIX = "opendum:api-key:validation";
export const LAST_USED_PREFIX = "opendum:api-key:last-used";
export const DISABLED_PREFIX = "opendum:user:disabled-models";
export const FAIL_PREFIX = "opendum:provider-account:refresh-fail-count";
export const ACCOUNT_AFFINITY_PREFIX = "opendum:account-affinity";
export const MODEL_SATURATION_PREFIX = "opendum:model-saturation";
export const ANALYTICS_VERSION_PREFIX = "opendum:analytics:v1:version";
export const VERSION_BUMP_PREFIX = "opendum:analytics:v1:version-bump";

export function validationKey(keyHash: string): string {
  return `${VALIDATION_PREFIX}:${keyHash}`;
}

export function lastUsed(apiKeyId: string): string {
  return `${LAST_USED_PREFIX}:${apiKeyId}`;
}

export function disabledKey(userId: string): string {
  return `${DISABLED_PREFIX}:${userId}`;
}

export function failCount(accountId: string): string {
  return `${FAIL_PREFIX}:${accountId}`;
}

export function affinityKey(userId: string, scope = ""): string {
  const normalized = scope.trim();
  return normalized
    ? `${ACCOUNT_AFFINITY_PREFIX}:${normalized}:${userId}`
    : `${ACCOUNT_AFFINITY_PREFIX}:${userId}`;
}

export function saturationKey(provider: string, model: string): string {
  return `${MODEL_SATURATION_PREFIX}:${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
}

export function versionKey(userId: string): string {
  return `${ANALYTICS_VERSION_PREFIX}:${userId}`;
}

export function versionBump(userId: string): string {
  return `${VERSION_BUMP_PREFIX}:${userId}`;
}
