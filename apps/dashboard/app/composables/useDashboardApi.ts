import type {
  AccountOverviewData,
  AccountOverviewResponse,
  AccountPingData,
  AccountStatsData,
  ActionResult,
  AnalyticsData,
  AnalyticsFilter,
  AnalyticsSeriesData,
  DashboardMeData,
  MaintenerAuditUser,
  MaintenerAuditUserListResult,
  AccountQuotaBatchRequest,
  ApiKeyListItem,
  ApiKeyOptions,
  ErrorHistoryResult,
  AccountQuotaBatchResult,
  AccountQuotaInfo,
  AccountQuotaRequest,
  ModelListItem,
  ModelSearchItem,
  ModelStatsData,
  PointStatusData,
  PlaygroundOptions,
  PlaygroundProxyAuth,
  ProviderDetailData,
  ProviderDetailResponse,
  ProviderAccountUpdateData,
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
    points: {
      status: () => dashboardFetch<PointStatusData>("/api/dashboard/points"),
    },
    accounts: {
      list: () => dashboardFetch("/api/dashboard/accounts"),
      byProvider: (query: { provider: string }) => dashboardFetch("/api/dashboard/accounts/provider", { query }),
      byProviderDetailed: (query: { provider: string }) => dashboardFetch<ProviderDetailData>("/api/dashboard/accounts/provider-detail", { query }),
      byProviderDetailedDelta: (query: { provider: string; cursor: string }) => dashboardFetch<ProviderDetailResponse>("/api/dashboard/accounts/provider-detail", { query }),
      stats: (body: { accountIds: string[]; cursors?: Record<string, string> }) => post<AccountStatsData>(dashboardFetch, "/api/dashboard/accounts/stats", body),
      overview: () => dashboardFetch<AccountOverviewData>("/api/dashboard/accounts/overview"),
      overviewDelta: (query: { cursor: string }) => dashboardFetch<AccountOverviewResponse>("/api/dashboard/accounts/overview", { query }),
      ping: () => dashboardFetch<AccountPingData>("/api/dashboard/accounts/ping"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => post<ActionResult<ProviderAccountUpdateData>>(dashboardFetch, "/api/dashboard/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>(dashboardFetch, "/api/dashboard/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>(dashboardFetch, "/api/dashboard/accounts/pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(dashboardFetch, "/api/dashboard/accounts/model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => dashboardFetch<ErrorHistoryResult>("/api/dashboard/accounts/errors", { query }),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>(dashboardFetch, "/api/dashboard/accounts/errors/resolve", body),
      getAuthUrl: (body: { provider: "antigravity" | "gemini_cli" | "codex" | "kiro" }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>(dashboardFetch, "/api/dashboard/accounts/oauth/url", body),
      exchangeOAuth: (body: { provider: "antigravity" | "gemini_cli" | "codex" | "kiro"; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/oauth/exchange", body),
      connectCodexSession: (body: { sessionJson: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/codex-session", body),
      initiateDeviceAuth: (body: { provider: "qwen_code" | "copilot" | "codex" }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string }>>(dashboardFetch, "/api/dashboard/accounts/device-auth/initiate", body),
      pollDeviceAuth: (body: { provider: "qwen_code" | "copilot" | "codex"; deviceCode: string; userCode?: string; codeVerifier?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>(dashboardFetch, "/api/dashboard/accounts/device-auth/poll", body),
      quota: (body: AccountQuotaRequest, options?: DashboardFetchOptions) => post<ActionResult<AccountQuotaInfo>>(dashboardFetch, "/api/dashboard/accounts/quota", body, options),
      quotas: (body: AccountQuotaBatchRequest, options?: DashboardFetchOptions) => post<ActionResult<AccountQuotaBatchResult>>(dashboardFetch, "/api/dashboard/accounts/quotas", body, options),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => post<AnalyticsData>(dashboardFetch, "/api/dashboard/analytics/data", body),
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => post<AnalyticsSeriesData>(dashboardFetch, "/api/dashboard/analytics/series", body),
      overview: () => dashboardFetch("/api/dashboard/analytics/overview"),
      usage: (query?: { range?: string }) => dashboardFetch("/api/dashboard/analytics/usage", { query }),
    },
    sharing: {
      get: () => dashboardFetch<{ enabled: boolean }>("/api/dashboard/sharing"),
      update: (body: { enabled: boolean }) => post<{ enabled: boolean }>(dashboardFetch, "/api/dashboard/sharing", body),
    },
    apiKeys: {
      list: () => dashboardFetch<ApiKeyListItem[]>("/api/dashboard/api-keys"),
      options: () => dashboardFetch<ApiKeyOptions>("/api/dashboard/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>(dashboardFetch, "/api/dashboard/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>(dashboardFetch, "/api/dashboard/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>(dashboardFetch, "/api/dashboard/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>(dashboardFetch, "/api/dashboard/api-keys/reveal", body),
      updateName: (body: { id: string; name: string; key?: string }) => post<ActionResult<{ name: string | null; keyPreview: string }>>(dashboardFetch, "/api/dashboard/api-keys/name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>(dashboardFetch, "/api/dashboard/api-keys/expiration", body),
      updateRoaming: (body: { id: string; enabled: boolean }) => post<ActionResult<{ roamingEnabled: boolean }>>(dashboardFetch, "/api/dashboard/api-keys/roaming", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>(dashboardFetch, "/api/dashboard/api-keys/model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>(dashboardFetch, "/api/dashboard/api-keys/account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>(dashboardFetch, "/api/dashboard/api-keys/rate-limits", body),
    },
    models: {
      list: (query?: { includeStats?: boolean }) => dashboardFetch<ModelListItem[]>("/api/dashboard/models", query ? { query } : undefined),
      search: () => dashboardFetch<ModelSearchItem[]>("/api/dashboard/models/search"),
      stats: (body: { models: string[]; cursors?: Record<string, string> }) => post<ModelStatsData>(dashboardFetch, "/api/dashboard/models/stats", body),
      familyCounts: () => dashboardFetch<Record<string, number>>("/api/dashboard/models/families"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(dashboardFetch, "/api/dashboard/models/enabled", body),
    },
    playground: {
      options: () => dashboardFetch<PlaygroundOptions>("/api/dashboard/playground/options"),
      auth: (body: { endpoint: PlaygroundEndpoint }) => post<PlaygroundProxyAuth>(dashboardFetch, "/api/dashboard/playground/auth", body),
    },
    maintener: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => dashboardFetch<MaintenerAuditUserListResult>("/api/dashboard/maintener/users/search", { query }),
      },
      audit: {
        start: (body: { userId: string }) => post<ActionResult<{ user: MaintenerAuditUser }>>(dashboardFetch, "/api/dashboard/maintener/audit/start", body),
        stop: () => post<ActionResult>(dashboardFetch, "/api/dashboard/maintener/audit/stop"),
      },
    },
  };
}
