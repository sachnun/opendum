import type {
  AccountSummaryData,
  AccountPingData,
  ActionResult,
  AnalyticsData,
  AnalyticsFilter,
  DashboardMeData,
  ApiKeyListItem,
  ApiKeyOptions,
  ErrorHistoryResult,
  AccountQuotaInfo,
  ModelListItem,
  ModelSearchItem,
  PlaygroundOptions,
  PlaygroundProxyAuth,
  ProviderDetailData,
  ProviderAccountUpdateData,
  QuotaProviderKey,
} from "../../lib/dashboard-api-types";

type ApiKeyAccessMode = "all" | "whitelist" | "blacklist";
type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

type DashboardFetch = ReturnType<typeof useRequestFetch>;
type DashboardFetchOptions = Parameters<DashboardFetch>[1];

function post<T>(fetcher: DashboardFetch, url: string, body?: Record<string, unknown>, options?: DashboardFetchOptions) {
  return fetcher<T>(url, { ...options, method: "POST", body });
}

export function useDashboardApi() {
  const dashboardFetch = useRequestFetch();

  return {
    me: {
      get: () => dashboardFetch<DashboardMeData>("/api/dashboard/me"),
    },
    accounts: {
      list: () => dashboardFetch("/api/dashboard/accounts"),
      byProvider: (query: { provider: string }) => dashboardFetch("/api/dashboard/accounts/by-provider", { query }),
      byProviderDetailed: (query: { provider: string }) => dashboardFetch<ProviderDetailData>("/api/dashboard/accounts/by-provider-detailed", { query }),
      summary: () => dashboardFetch<AccountSummaryData>("/api/dashboard/accounts/summary"),
      ping: () => dashboardFetch<AccountPingData>("/api/dashboard/accounts/ping"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => post<ActionResult<ProviderAccountUpdateData>>(dashboardFetch, "/api/dashboard/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>(dashboardFetch, "/api/dashboard/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>(dashboardFetch, "/api/dashboard/accounts/toggle-pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(dashboardFetch, "/api/dashboard/accounts/set-account-model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => dashboardFetch<ErrorHistoryResult>("/api/dashboard/accounts/error-history", { query }),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>(dashboardFetch, "/api/dashboard/accounts/resolve-errors", body),
      getAuthUrl: (body: { provider: "antigravity" | "gemini_cli" | "codex" | "kiro" }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>(dashboardFetch, "/api/dashboard/accounts/auth-url", body),
      exchangeOAuth: (body: { provider: "antigravity" | "gemini_cli" | "codex" | "kiro"; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/exchange-oauth", body),
      initiateDeviceAuth: (body: { provider: "qwen_code" | "copilot" | "codex" }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string }>>(dashboardFetch, "/api/dashboard/accounts/initiate-device-auth", body),
      pollDeviceAuth: (body: { provider: "qwen_code" | "copilot" | "codex"; deviceCode: string; userCode?: string; codeVerifier?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/poll-device-auth", body),
      quota: (body: { provider: QuotaProviderKey; accountId: string; forceRefresh?: boolean }, options?: DashboardFetchOptions) => post<ActionResult<AccountQuotaInfo>>(dashboardFetch, "/api/dashboard/accounts/quota", body, options),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => post<AnalyticsData>(dashboardFetch, "/api/dashboard/analytics/data", body),
      overview: () => dashboardFetch("/api/dashboard/analytics/overview"),
      byApiKey: (body: { apiKeyId: string; filter?: AnalyticsFilter }) => post(dashboardFetch, "/api/dashboard/analytics/by-api-key", body),
      usage: (query?: { range?: string }) => dashboardFetch("/api/dashboard/analytics/usage", { query }),
    },
    apiKeys: {
      list: () => dashboardFetch<ApiKeyListItem[]>("/api/dashboard/api-keys"),
      options: () => dashboardFetch<ApiKeyOptions>("/api/dashboard/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>(dashboardFetch, "/api/dashboard/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>(dashboardFetch, "/api/dashboard/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>(dashboardFetch, "/api/dashboard/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>(dashboardFetch, "/api/dashboard/api-keys/reveal", body),
      updateName: (body: { id: string; name: string }) => post<ActionResult<{ name: string | null }>>(dashboardFetch, "/api/dashboard/api-keys/update-name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>(dashboardFetch, "/api/dashboard/api-keys/update-expiration", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>(dashboardFetch, "/api/dashboard/api-keys/update-model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>(dashboardFetch, "/api/dashboard/api-keys/update-account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>(dashboardFetch, "/api/dashboard/api-keys/update-rate-limits", body),
    },
    models: {
      list: () => dashboardFetch<ModelListItem[]>("/api/dashboard/models"),
      search: () => dashboardFetch<ModelSearchItem[]>("/api/dashboard/models/search"),
      familyCounts: () => dashboardFetch<Record<string, number>>("/api/dashboard/models/family-counts"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(dashboardFetch, "/api/dashboard/models/set-enabled", body),
    },
    playground: {
      options: () => dashboardFetch<PlaygroundOptions>("/api/dashboard/playground/options"),
      auth: (body: { endpoint: PlaygroundEndpoint }) => post<PlaygroundProxyAuth>(dashboardFetch, "/api/dashboard/playground/auth", body),
    },
  };
}
