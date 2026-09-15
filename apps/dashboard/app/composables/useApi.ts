import type {
  AccountOverviewData,
  AccountOverviewResponse,
  AccountPingData,
  AccountStatsData,
  ActionResult,
  AnalyticsData,
  AnalyticsFilter,
  AnalyticsSeriesData,
  MeData,
  MaintenerAuditUser,
  MaintenerAuditUserListResult,
  AccountQuotaBatchRequest,
  ApiKeyListItem,
  ApiKeyOptions,
  ErrorHistoryBatchResult,
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
} from "../../lib/api-types";
import type { DeviceProviderKey, OAuthProviderKey } from "../../lib/provider-accounts";

type ApiKeyAccessMode = "all" | "whitelist" | "blacklist";
type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

type ApiFetch = ReturnType<typeof useRequestFetch>;
type ApiFetchOptions = Parameters<ApiFetch>[1];
type ApiFetchBody = NonNullable<ApiFetchOptions>["body"];

function post<T>(fetcher: ApiFetch, url: string, body?: ApiFetchBody, options?: ApiFetchOptions) {
  return fetcher<T>(url, { ...options, method: "POST", body });
}

function cursorQuery(ids: string[], cursors?: Record<string, string>) {
  const cursorValues = ids.map((id) => cursors?.[id] ?? "");

  return {
    ids,
    ...(cursorValues.some(Boolean) ? { cursors: cursorValues } : {}),
  };
}

export function useApi() {
  const apiFetch = useRequestFetch();

  return {
    me: {
      get: () => apiFetch<MeData>("/api/dashboard/me"),
    },
    points: {
      status: () => apiFetch<PointStatusData>("/api/dashboard/points"),
    },
    accounts: {
      list: () => apiFetch("/api/dashboard/accounts"),
      byProvider: (query: { provider: string }) => apiFetch("/api/dashboard/accounts/provider", { query }),
      byProviderDetailed: (query: { provider: string }) => apiFetch<ProviderDetailData>("/api/dashboard/accounts/provider-detail", { query }),
      byProviderDetailedDelta: (query: { provider: string; cursor: string }) => apiFetch<ProviderDetailResponse>("/api/dashboard/accounts/provider-detail", { query }),
      stats: (query: { accountIds: string[]; cursors?: Record<string, string> }) => apiFetch<AccountStatsData>("/api/dashboard/accounts/stats", { query: cursorQuery(query.accountIds, query.cursors) }),
      overview: () => apiFetch<AccountOverviewData>("/api/dashboard/accounts/overview"),
      overviewDelta: (query: { cursor: string }) => apiFetch<AccountOverviewResponse>("/api/dashboard/accounts/overview", { query }),
      ping: () => apiFetch<AccountPingData>("/api/dashboard/accounts/ping"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string; platformKey?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/api/dashboard/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => post<ActionResult<ProviderAccountUpdateData>>(apiFetch, "/api/dashboard/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>(apiFetch, "/api/dashboard/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>(apiFetch, "/api/dashboard/accounts/pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(apiFetch, "/api/dashboard/accounts/model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => apiFetch<ErrorHistoryResult>("/api/dashboard/accounts/errors", { query }),
      errorHistories: (body: { accountIds: string[]; limit?: number }) => post<ErrorHistoryBatchResult>(apiFetch, "/api/dashboard/accounts/errors/batch", body),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>(apiFetch, "/api/dashboard/accounts/errors/resolve", body),
      getAuthUrl: (body: { provider: OAuthProviderKey }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>(apiFetch, "/api/dashboard/accounts/oauth/url", body),
      exchangeOAuth: (body: { provider: OAuthProviderKey; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/api/dashboard/accounts/oauth/exchange", body),
      connectCodexSession: (body: { sessionJson: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/api/dashboard/accounts/codex-session", body),
      copySession: (body: { id: string }) => post<ActionResult<{ session: string }>>(apiFetch, "/api/dashboard/accounts/session", body),
      initiateDeviceAuth: (body: { provider: DeviceProviderKey; method?: string }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string; expiresIn?: number; interval?: number }>>(apiFetch, "/api/dashboard/accounts/device-auth/initiate", body),
      pollDeviceAuth: (body: { provider: DeviceProviderKey; deviceCode: string; userCode?: string; codeVerifier?: string; method?: string; machineId?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>(apiFetch, "/api/dashboard/accounts/device-auth/poll", body),
      quota: (body: AccountQuotaRequest, options?: ApiFetchOptions) => post<ActionResult<AccountQuotaInfo>>(apiFetch, "/api/dashboard/accounts/quota", body, options),
      quotas: (body: AccountQuotaBatchRequest, options?: ApiFetchOptions) => post<ActionResult<AccountQuotaBatchResult>>(apiFetch, "/api/dashboard/accounts/quotas", body, options),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => post<AnalyticsData>(apiFetch, "/api/dashboard/analytics/data", body),
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => post<AnalyticsSeriesData>(apiFetch, "/api/dashboard/analytics/series", body),
      overview: () => apiFetch("/api/dashboard/analytics/overview"),
      usage: (query?: { range?: string }) => apiFetch("/api/dashboard/analytics/usage", { query }),
    },
    sharing: {
      get: () => apiFetch<{ enabled: boolean }>("/api/dashboard/sharing"),
      update: (body: { enabled: boolean }) => post<{ enabled: boolean }>(apiFetch, "/api/dashboard/sharing", body),
    },
    apiKeys: {
      list: () => apiFetch<ApiKeyListItem[]>("/api/dashboard/api-keys"),
      options: () => apiFetch<ApiKeyOptions>("/api/dashboard/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>(apiFetch, "/api/dashboard/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>(apiFetch, "/api/dashboard/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>(apiFetch, "/api/dashboard/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>(apiFetch, "/api/dashboard/api-keys/reveal", body),
      updateName: (body: { id: string; name: string; key?: string }) => post<ActionResult<{ name: string | null; keyPreview: string }>>(apiFetch, "/api/dashboard/api-keys/name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>(apiFetch, "/api/dashboard/api-keys/expiration", body),
      updateRoaming: (body: { id: string; enabled: boolean }) => post<ActionResult<{ roamingEnabled: boolean }>>(apiFetch, "/api/dashboard/api-keys/roaming", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>(apiFetch, "/api/dashboard/api-keys/model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>(apiFetch, "/api/dashboard/api-keys/account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>(apiFetch, "/api/dashboard/api-keys/rate-limits", body),
    },
    models: {
      list: (query?: { includeStats?: boolean }) => apiFetch<ModelListItem[]>("/api/dashboard/models", query ? { query } : undefined),
      search: () => apiFetch<ModelSearchItem[]>("/api/dashboard/models/search"),
      stats: (query: { models: string[]; cursors?: Record<string, string> }) => apiFetch<ModelStatsData>("/api/dashboard/models/stats", { query: cursorQuery(query.models, query.cursors) }),
      familyCounts: () => apiFetch<Record<string, number>>("/api/dashboard/models/families"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(apiFetch, "/api/dashboard/models/enabled", body),
    },
    playground: {
      options: () => apiFetch<PlaygroundOptions>("/api/dashboard/playground/options"),
      auth: (body: { endpoint: PlaygroundEndpoint }) => post<PlaygroundProxyAuth>(apiFetch, "/api/dashboard/playground/auth", body),
    },
    maintener: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => apiFetch<MaintenerAuditUserListResult>("/api/dashboard/maintener/users/search", { query }),
      },
      audit: {
        start: (body: { userId: string }) => post<ActionResult<{ user: MaintenerAuditUser }>>(apiFetch, "/api/dashboard/maintener/audit/start", body),
        stop: () => post<ActionResult>(apiFetch, "/api/dashboard/maintener/audit/stop"),
      },
    },
  };
}
