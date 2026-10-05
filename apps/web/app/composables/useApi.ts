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
  MaintainerAuditUser,
  MaintainerAuditUserListResult,
  AccountQuotaBatchRequest,
  ApiKeyListItem,
  ApiKeyOptions,
  ErrorHistoryBatchResult,
  ErrorHistoryResult,
  AccountQuotaBatchResult,
  AccountQuotaInfo,
  AccountQuotaRequest,
  CustomProviderListItem,
  CustomProviderCreateResult,
  CustomProviderSyncResult,
  CustomProviderConnectResult,
  CustomProviderModelFlags,
  ModelListItem,
  ModelSearchItem,
  ModelStatsData,
  PointStatusData,
  PlaygroundOptions,
  PlaygroundProxyAuth,
  ProviderDetailData,
  ProviderDetailResponse,
  ProviderAccountUpdateData,
} from "#shared/api";
import type { DeviceProviderKey, OAuthProviderKey } from "#shared/provider-accounts";

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
      get: () => apiFetch<MeData>("/api/web/me"),
    },
    points: {
      status: () => apiFetch<PointStatusData>("/api/web/points"),
    },
    accounts: {
      list: () => apiFetch("/api/web/accounts"),
      byProvider: (query: { provider: string }) => apiFetch("/api/web/accounts/provider", { query }),
      byProviderDetailed: (query: { provider: string }) => apiFetch<ProviderDetailData>("/api/web/accounts/provider-detail", { query }),
      byProviderDetailedDelta: (query: { provider: string; cursor: string }) => apiFetch<ProviderDetailResponse>("/api/web/accounts/provider-detail", { query }),
      stats: (query: { accountIds: string[]; cursors?: Record<string, string> }) => apiFetch<AccountStatsData>("/api/web/accounts/stats", { query: cursorQuery(query.accountIds, query.cursors) }),
      overview: () => apiFetch<AccountOverviewData>("/api/web/accounts/overview"),
      overviewDelta: (query: { cursor: string }) => apiFetch<AccountOverviewResponse>("/api/web/accounts/overview", { query }),
      ping: () => apiFetch<AccountPingData>("/api/web/accounts/ping"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string; platformKey?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/api/web/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => post<ActionResult<ProviderAccountUpdateData>>(apiFetch, "/api/web/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>(apiFetch, "/api/web/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>(apiFetch, "/api/web/accounts/pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(apiFetch, "/api/web/accounts/model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => apiFetch<ErrorHistoryResult>("/api/web/accounts/errors", { query }),
      errorHistories: (body: { accountIds: string[]; limit?: number }) => post<ErrorHistoryBatchResult>(apiFetch, "/api/web/accounts/errors/batch", body),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>(apiFetch, "/api/web/accounts/errors/resolve", body),
      getAuthUrl: (body: { provider: OAuthProviderKey }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>(apiFetch, "/api/web/accounts/oauth/url", body),
      exchangeOAuth: (body: { provider: OAuthProviderKey; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/api/web/accounts/oauth/exchange", body),
      connectCodexSession: (body: { sessionJson: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/api/web/accounts/codex-session", body),
      copySession: (body: { id: string }) => post<ActionResult<{ session: string }>>(apiFetch, "/api/web/accounts/session", body),
      initiateDeviceAuth: (body: { provider: DeviceProviderKey; method?: string }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string; expiresIn?: number; interval?: number }>>(apiFetch, "/api/web/accounts/device-auth/initiate", body),
      pollDeviceAuth: (body: { provider: DeviceProviderKey; deviceCode: string; userCode?: string; codeVerifier?: string; method?: string; machineId?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>(apiFetch, "/api/web/accounts/device-auth/poll", body),
      quota: (body: AccountQuotaRequest, options?: ApiFetchOptions) => post<ActionResult<AccountQuotaInfo>>(apiFetch, "/api/web/accounts/quota", body, options),
      quotas: (body: AccountQuotaBatchRequest, options?: ApiFetchOptions) => post<ActionResult<AccountQuotaBatchResult>>(apiFetch, "/api/web/accounts/quotas", body, options),
    },
    customProviders: {
      list: () => apiFetch<CustomProviderListItem[]>("/api/web/custom-providers"),
      create: (body: { slug: string; name: string; baseUrl: string; extraHeaders?: Record<string, string> }) => post<ActionResult<CustomProviderCreateResult>>(apiFetch, "/api/web/custom-providers", body),
      update: (body: { slug: string; name?: string; baseUrl?: string; extraHeaders?: Record<string, string>; enabled?: boolean }) => post<ActionResult>(apiFetch, "/api/web/custom-providers/update", body),
      remove: (body: { slug: string }) => post<ActionResult>(apiFetch, "/api/web/custom-providers/delete", body),
      connect: (body: { slug: string; token: string; name?: string }) => post<ActionResult<CustomProviderConnectResult>>(apiFetch, "/api/web/custom-providers/connect", body),
      syncModels: (body: { slug: string; token?: string }) => post<ActionResult<CustomProviderSyncResult>>(apiFetch, "/api/web/custom-providers/sync-models", body),
      previewModels: (body: { baseUrl: string; extraHeaders?: Record<string, string>; token?: string }) => post<ActionResult<{ models: Array<{ modelId: string; upstream: string }> }>>(apiFetch, "/api/web/custom-providers/preview-models", body),
      addModels: (body: { slug: string; models: Array<{ modelId: string; upstream?: string; aliased?: boolean; authless?: boolean; minTier?: string; allowedTiers?: string[]; customFlags?: CustomProviderModelFlags }> }) => post<ActionResult<{ added: number }>>(apiFetch, "/api/web/custom-providers/models", body),
      deleteModel: (body: { slug: string; modelId: string }) => post<ActionResult>(apiFetch, "/api/web/custom-providers/models/delete", body),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => post<AnalyticsData>(apiFetch, "/api/web/analytics/data", body),
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => post<AnalyticsSeriesData>(apiFetch, "/api/web/analytics/series", body),
      overview: () => apiFetch("/api/web/analytics/overview"),
      usage: (query?: { range?: string }) => apiFetch("/api/web/analytics/usage", { query }),
    },
    sharing: {
      get: () => apiFetch<{ enabled: boolean }>("/api/web/sharing"),
      update: (body: { enabled: boolean }) => post<{ enabled: boolean }>(apiFetch, "/api/web/sharing", body),
    },
    apiKeys: {
      list: () => apiFetch<ApiKeyListItem[]>("/api/web/api-keys"),
      options: () => apiFetch<ApiKeyOptions>("/api/web/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>(apiFetch, "/api/web/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>(apiFetch, "/api/web/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>(apiFetch, "/api/web/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>(apiFetch, "/api/web/api-keys/reveal", body),
      updateName: (body: { id: string; name: string; key?: string }) => post<ActionResult<{ name: string | null; keyPreview: string }>>(apiFetch, "/api/web/api-keys/name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>(apiFetch, "/api/web/api-keys/expiration", body),
      updateRoaming: (body: { id: string; enabled: boolean }) => post<ActionResult<{ roamingEnabled: boolean }>>(apiFetch, "/api/web/api-keys/roaming", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>(apiFetch, "/api/web/api-keys/model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>(apiFetch, "/api/web/api-keys/account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>(apiFetch, "/api/web/api-keys/rate-limits", body),
    },
    models: {
      list: (query?: { includeStats?: boolean }) => apiFetch<ModelListItem[]>("/api/web/models", query ? { query } : undefined),
      search: () => apiFetch<ModelSearchItem[]>("/api/web/models/search"),
      catalog: () => apiFetch<string[]>("/api/web/models/catalog"),
      stats: (query: { models: string[]; cursors?: Record<string, string> }) => apiFetch<ModelStatsData>("/api/web/models/stats", { query: cursorQuery(query.models, query.cursors) }),
      familyCounts: () => apiFetch<Record<string, number>>("/api/web/models/families"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(apiFetch, "/api/web/models/enabled", body),
    },
    playground: {
      options: () => apiFetch<PlaygroundOptions>("/api/web/playground/options"),
      auth: (body: { endpoint: PlaygroundEndpoint }) => post<PlaygroundProxyAuth>(apiFetch, "/api/web/playground/auth", body),
    },
    maintainer: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => apiFetch<MaintainerAuditUserListResult>("/api/web/maintainer/users/search", { query }),
      },
      audit: {
        start: (body: { userId: string }) => post<ActionResult<{ user: MaintainerAuditUser }>>(apiFetch, "/api/web/maintainer/audit/start", body),
        stop: () => post<ActionResult>(apiFetch, "/api/web/maintainer/audit/stop"),
      },
    },
  };
}
