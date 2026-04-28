// @opendum/shared - Main barrel export

// Database
export { db, schema } from "./db/index.js";
export {
  user,
  session,
  account,
  verification,
  providerAccount,
  providerAccountErrorHistory,
  providerAccountModelHealth,
  providerAccountDisabledModel,
  disabledModel,
  proxyApiKey,
  proxyApiKeyRateLimit,
  usageLog,
  type ProviderAccount,
} from "./db/schema.js";
export {
  userRelations,
  sessionRelations,
  accountRelations,
  providerAccountRelations,
  providerAccountErrorHistoryRelations,
  providerAccountModelHealthRelations,
  providerAccountDisabledModelRelations,
  proxyApiKeyRelations,
  proxyApiKeyRateLimitRelations,
  usageLogRelations,
  disabledModelRelations,
} from "./db/relations.js";

// Encryption
export {
  encrypt,
  decrypt,
  hashString,
  generateApiKey,
  getKeyPreview,
} from "./encryption.js";

// Redis
export { getRedisClient } from "./redis.js";
export { getRedisJson, setRedisJson, deleteRedisKey } from "./redis-cache.js";

// Cache
export {
  buildAnalyticsCacheKey,
  getAnalyticsCacheVersion,
  bumpAnalyticsCacheVersionThrottled,
} from "./cache/analytics-cache.js";

// Proxy - Models
export {
  MODEL_REGISTRY,
  IGNORED_MODELS,
  type ModelMeta,
  type ModelInfo,
  resolveModelAlias,
  getProvidersForModel,
  isModelSupported,
  isModelSupportedByProvider,
  getAllModels,
  getAllModelsWithAliases,
  getModelsForProvider,
  getProviderModelMap,
  getProviderModelSet,
  getUpstreamModelName,
  getProviderAccessRule,
  getProviderModelConfig,
  getModelLookupKeys,
  formatModelsForOpenAI,
  getModelInfo,
  isVisionModel,
  getModelFamily,
  getAllFamilies,
  getModelsByFamily,
} from "./proxy/models.js";

// Proxy - Dashboard cache/model helpers
export {
  invalidateDisabledModelsCache,
  invalidateApiKeyValidationCache,
  getAccountModelAvailability,
  isModelUsableByAccounts,
  type AccountModelAvailability,
} from "./proxy/auth.js";

// Cron
export {
  refreshTokens,
  type RefreshResult,
  type RefreshTokensSummary,
  type RefreshTokensResponse,
} from "./cron/refresh-tokens.js";

// Proxy - Providers
export {
  getProvider,
  isValidProvider,
} from "./proxy/providers/registry.js";
export {
  ProviderName,
  OAUTH_PROVIDER_NAMES,
  type Provider,
  type ProviderConfig,
  type ProviderNameType,
  type OAuthResult,
  type ChatCompletionRequest,
  type ProxyEndpointType,
  type ReasoningEffort,
  type ReasoningConfig,
} from "./proxy/providers/types.js";
