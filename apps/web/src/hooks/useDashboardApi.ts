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
} from "../lib/dashboard-api-types";

type ApiKeyAccessMode = "all" | "whitelist" | "blacklist";
type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...options });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function post<T>(url: string, body?: unknown, options?: RequestInit): Promise<T> {
  return request<T>(url, {
    ...options,
    method: "POST",
    headers: { "content-type": "application/json", ...(options?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function withQuery(url: string, query?: Record<string, unknown>): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function cursorQuery(ids: string[], cursors?: Record<string, string>) {
  const cursorValues = ids.map((id) => cursors?.[id] ?? "");
  return {
    ids,
    ...(cursorValues.some(Boolean) ? { cursors: cursorValues } : {}),
  };
}

export function useDashboardApi() {
  return {
    me: {
      get: () => request<DashboardMeData>("/api/dashboard/me"),
    },
    points: {
      status: () => request<PointStatusData>("/api/dashboard/points"),
    },
    accounts: {
      list: () => request("/api/dashboard/accounts"),
      byProvider: (query: { provider: string }) => request(withQuery("/api/dashboard/accounts/provider", query)),
      byProviderDetailed: (query: { provider: string }) => request<ProviderDetailData>(withQuery("/api/dashboard/accounts/provider-detail", query)),
      byProviderDetailedDelta: (query: { provider: string; cursor: string }) => request<ProviderDetailResponse>(withQuery("/api/dashboard/accounts/provider-detail", query)),
      stats: (query: { accountIds: string[]; cursors?: Record<string, string> }) => request<AccountStatsData>(withQuery("/api/dashboard/accounts/stats", cursorQuery(query.accountIds, query.cursors))),
      overview: () => request<AccountOverviewData>("/api/dashboard/accounts/overview"),
      overviewDelta: (query: { cursor: string }) => request<AccountOverviewResponse>(withQuery("/api/dashboard/accounts/overview", query)),
      ping: () => request<AccountPingData>("/api/dashboard/accounts/ping"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string; platformKey?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>("/api/dashboard/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => post<ActionResult<ProviderAccountUpdateData>>("/api/dashboard/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>("/api/dashboard/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>("/api/dashboard/accounts/pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>("/api/dashboard/accounts/model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => request<ErrorHistoryResult>(withQuery("/api/dashboard/accounts/errors", query)),
      errorHistories: (body: { accountIds: string[]; limit?: number }) => post<ErrorHistoryBatchResult>("/api/dashboard/accounts/errors/batch", body),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>("/api/dashboard/accounts/errors/resolve", body),
      getAuthUrl: (body: { provider: "antigravity" | "codex" | "kiro" }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>("/api/dashboard/accounts/oauth/url", body),
      exchangeOAuth: (body: { provider: "antigravity" | "codex" | "kiro"; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>("/api/dashboard/accounts/oauth/exchange", body),
      connectCodexSession: (body: { sessionJson: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>("/api/dashboard/accounts/codex-session", body),
      initiateDeviceAuth: (body: { provider: "codex" | "qoder"; method?: string }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string; expiresIn?: number; interval?: number }>>("/api/dashboard/accounts/device-auth/initiate", body),
      pollDeviceAuth: (body: { provider: "codex" | "qoder"; deviceCode: string; userCode?: string; codeVerifier?: string; method?: string; machineId?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>("/api/dashboard/accounts/device-auth/poll", body),
      quota: (body: AccountQuotaRequest, options?: RequestInit) => post<ActionResult<AccountQuotaInfo>>("/api/dashboard/accounts/quota", body, options),
      quotas: (body: AccountQuotaBatchRequest, options?: RequestInit) => post<ActionResult<AccountQuotaBatchResult>>("/api/dashboard/accounts/quotas", body, options),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => post<AnalyticsData>("/api/dashboard/analytics/data", body),
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => post<AnalyticsSeriesData>("/api/dashboard/analytics/series", body),
      overview: () => request("/api/dashboard/analytics/overview"),
      usage: (query?: { range?: string }) => request(withQuery("/api/dashboard/analytics/usage", query)),
    },
    sharing: {
      get: () => request<{ enabled: boolean }>("/api/dashboard/sharing"),
      update: (body: { enabled: boolean }) => post<{ enabled: boolean }>("/api/dashboard/sharing", body),
    },
    apiKeys: {
      list: () => request<ApiKeyListItem[]>("/api/dashboard/api-keys"),
      options: () => request<ApiKeyOptions>("/api/dashboard/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>("/api/dashboard/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>("/api/dashboard/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>("/api/dashboard/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>("/api/dashboard/api-keys/reveal", body),
      updateName: (body: { id: string; name: string; key?: string }) => post<ActionResult<{ name: string | null; keyPreview: string }>>("/api/dashboard/api-keys/name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>("/api/dashboard/api-keys/expiration", body),
      updateRoaming: (body: { id: string; enabled: boolean }) => post<ActionResult<{ roamingEnabled: boolean }>>("/api/dashboard/api-keys/roaming", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>("/api/dashboard/api-keys/model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>("/api/dashboard/api-keys/account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>("/api/dashboard/api-keys/rate-limits", body),
    },
    models: {
      list: (query?: { includeStats?: boolean }) => request<ModelListItem[]>(withQuery("/api/dashboard/models", query)),
      search: () => request<ModelSearchItem[]>("/api/dashboard/models/search"),
      stats: (query: { models: string[]; cursors?: Record<string, string> }) => request<ModelStatsData>(withQuery("/api/dashboard/models/stats", cursorQuery(query.models, query.cursors))),
      familyCounts: () => request<Record<string, number>>("/api/dashboard/models/families"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>("/api/dashboard/models/enabled", body),
    },
    playground: {
      options: () => request<PlaygroundOptions>("/api/dashboard/playground/options"),
      auth: (body: { endpoint: PlaygroundEndpoint }) => post<PlaygroundProxyAuth>("/api/dashboard/playground/auth", body),
    },
    maintener: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => request<MaintenerAuditUserListResult>(withQuery("/api/dashboard/maintener/users/search", query)),
      },
      audit: {
        start: (body: { userId: string }) => post<ActionResult<{ user: MaintenerAuditUser }>>("/api/dashboard/maintener/audit/start", body),
        stop: () => post<ActionResult>("/api/dashboard/maintener/audit/stop"),
      },
    },
  };
}

export type DashboardApi = ReturnType<typeof useDashboardApi>;
