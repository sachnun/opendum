import type {
  AccountSummaryData,
  ActionResult,
  AnalyticsData,
  AnalyticsFilter,
  ApiKeyListItem,
  ApiKeyOptions,
  ErrorHistoryResult,
  ModelListItem,
  ModelSearchItem,
  PlaygroundOptions,
  ProviderDetailData,
} from "../../lib/dashboard-api-types";

type ApiKeyAccessMode = "all" | "whitelist" | "blacklist";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

function post<T>(url: string, body?: Record<string, unknown>) {
  return $fetch<T>(url, { method: "POST", body });
}

export function useDashboardApi() {
  return {
    accounts: {
      list: () => $fetch("/api/dashboard/accounts"),
      byProvider: (query: { provider: string }) => $fetch("/api/dashboard/accounts/by-provider", { query }),
      byProviderDetailed: (query: { provider: string }) => $fetch<ProviderDetailData>("/api/dashboard/accounts/by-provider-detailed", { query }),
      summary: () => $fetch<AccountSummaryData>("/api/dashboard/accounts/summary"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>("/api/dashboard/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean }) => post<ActionResult>("/api/dashboard/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>("/api/dashboard/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>("/api/dashboard/accounts/toggle-pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>("/api/dashboard/accounts/set-account-model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => $fetch<ErrorHistoryResult>("/api/dashboard/accounts/error-history", { query }),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>("/api/dashboard/accounts/resolve-errors", body),
      getAuthUrl: (body: { provider: "antigravity" | "gemini_cli" | "codex" | "kiro" }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>("/api/dashboard/accounts/auth-url", body),
      exchangeOAuth: (body: { provider: "antigravity" | "gemini_cli" | "codex" | "kiro"; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>("/api/dashboard/accounts/exchange-oauth", body),
      initiateDeviceAuth: (body: { provider: "qwen_code" | "copilot" }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string }>>("/api/dashboard/accounts/initiate-device-auth", body),
      pollDeviceAuth: (body: { provider: "qwen_code" | "copilot"; deviceCode: string; codeVerifier?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>("/api/dashboard/accounts/poll-device-auth", body),
      quota: (body: { provider: "antigravity" | "copilot" | "codex" | "gemini_cli" | "kiro" | "openrouter"; accountId: string; forceRefresh?: boolean }) => post<ActionResult<{ tier: string; status: "success" | "error" | "expired"; error?: string; groups: Array<{ name: string; displayName: string; remainingFraction: number; resetTimeIso: string | null; resetInHuman: string | null }> }>>("/api/dashboard/accounts/quota", body),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; forceRefresh?: boolean }) => post<AnalyticsData>("/api/dashboard/analytics/data", body),
      overview: () => $fetch("/api/dashboard/analytics/overview"),
      byApiKey: (body: { apiKeyId: string; filter?: AnalyticsFilter; forceRefresh?: boolean }) => post("/api/dashboard/analytics/by-api-key", body),
      usage: (query?: { range?: string }) => $fetch("/api/dashboard/analytics/usage", { query }),
    },
    apiKeys: {
      list: () => $fetch<ApiKeyListItem[]>("/api/dashboard/api-keys"),
      options: () => $fetch<ApiKeyOptions>("/api/dashboard/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>("/api/dashboard/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult>("/api/dashboard/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>("/api/dashboard/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>("/api/dashboard/api-keys/reveal", body),
      updateName: (body: { id: string; name: string }) => post<ActionResult<{ name: string | null }>>("/api/dashboard/api-keys/update-name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>("/api/dashboard/api-keys/update-expiration", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>("/api/dashboard/api-keys/update-model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>("/api/dashboard/api-keys/update-account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>("/api/dashboard/api-keys/update-rate-limits", body),
    },
    models: {
      list: () => $fetch<ModelListItem[]>("/api/dashboard/models"),
      search: () => $fetch<ModelSearchItem[]>("/api/dashboard/models/search"),
      familyCounts: () => $fetch<Record<string, number>>("/api/dashboard/models/family-counts"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>("/api/dashboard/models/set-enabled", body),
    },
    playground: {
      options: () => $fetch<PlaygroundOptions>("/api/dashboard/playground/options"),
    },
  };
}
