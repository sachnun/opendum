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
  providerAccountDisabledModel,
  disabledModel,
  proxyApiKey,
  usageLog,
  type ProviderAccount,
} from "./db/schema.js";
export {
  userRelations,
  sessionRelations,
  accountRelations,
  providerAccountRelations,
  providerAccountErrorHistoryRelations,
  providerAccountDisabledModelRelations,
  proxyApiKeyRelations,
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
  getModelLookupKeys,
  formatModelsForOpenAI,
  getModelInfo,
  isVisionModel,
  getModelFamily,
  getAllFamilies,
  getModelsByFamily,
} from "./proxy/models.js";

// Proxy - Auth (API key validation)
export {
  validateApiKey,
  validateModel,
  validateModelForUser,
  parseModelParam,
  logUsage,
  getDisabledModelSetForUser,
  invalidateDisabledModelsCache,
  invalidateApiKeyValidationCache,
  type ParsedModel,
  type ModelValidationResult,
  type ApiKeyModelAccessMode,
  type ApiKeyModelAccess,
  type ApiKeyAccountAccessMode,
  type ApiKeyAccountAccess,
} from "./proxy/auth.js";

// Proxy - Adaptive Timeout
export { getAdaptiveTimeout, recordLatency } from "./proxy/adaptive-timeout.js";

// Proxy - Message Sanitizer
export { stripImageContent } from "./proxy/message-sanitizer.js";

// Proxy - Timeout
export { fetchWithTimeout, type OnTTFBCallback } from "./proxy/timeout.js";

// Proxy - Providers
export {
  getProvider,
  getAllProviders,
  isValidProvider,
} from "./proxy/providers/registry.js";
export {
  ProviderName,
  OAUTH_PROVIDER_NAMES,
  API_KEY_PROVIDER_NAMES,
  PROVIDER_ALIASES,
  normalizeProviderAlias,
  DEFAULT_PROVIDER_TIMEOUTS,
  type Provider,
  type ProviderConfig,
  type ProviderNameType,
  type ProviderTimeouts,
  type OAuthResult,
  type ChatCompletionRequest,
  type ProxyEndpointType,
  type ReasoningEffort,
  type ReasoningConfig,
} from "./proxy/providers/types.js";
