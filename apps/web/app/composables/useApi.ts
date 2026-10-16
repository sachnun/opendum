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
} from "../../lib/api-types";
import type { DeviceProviderKey, OAuthProviderKey } from "@opendum/providers/provider-accounts";
import { getAccessToken } from "../../lib/auth-token";
import { resolveApiUrl } from "../../lib/api-url";

type ApiKeyAccessMode = "all" | "whitelist" | "blacklist";
type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

type ApiFetchOptions = Record<string, unknown>;
type ApiFetch = <T = unknown>(url: string, options?: ApiFetchOptions) => Promise<T>;
type ApiFetchBody = NonNullable<ApiFetchOptions>["body"];

function isUnauthorized(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const failure = error as { status?: number; statusCode?: number; response?: { status?: number } };
  return failure.status === 401 || failure.statusCode === 401 || failure.response?.status === 401;
}

function withAuthHeader(headers: unknown): Record<string, string> | undefined {
  const merged = { ...(headers as Record<string, string> | undefined) };
  const token = getAccessToken();
  if (token && !merged.authorization) merged.authorization = `Bearer ${token}`;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function createApiFetch(baseURL: string, refresh: () => Promise<boolean>): ApiFetch {
  return async <T>(url: string, options?: ApiFetchOptions) => {
    const request = () => $fetch<T>(`${baseURL}${url}`, { ...options, headers: withAuthHeader(options?.headers) });

    try {
      return await request();
    } catch (error) {
      if (!isUnauthorized(error) || !(await refresh())) throw error;

      return await request();
    }
  };
}

function post<T>(fetcher: ApiFetch, url: string, body?: ApiFetchBody, options?: ApiFetchOptions) {
  const request = fetcher as unknown as (url: string, options?: Record<string, unknown>) => Promise<T>;
  return request(url, { ...options, method: "POST", body });
}

function cursorQuery(ids: string[], cursors?: Record<string, string>) {
  const cursorValues = ids.map((id) => cursors?.[id] ?? "");

  return {
    ids,
    ...(cursorValues.some(Boolean) ? { cursors: cursorValues } : {}),
  };
}

export function useApi() {
  const config = useRuntimeConfig();
  const auth = useAuth();
  const apiFetch = createApiFetch(resolveApiUrl(config.public.apiUrl), async () => {
    if (await auth.refreshAccessToken()) return true;

    auth.expireSession();
    void navigateTo("/");
    return false;
  });

  return {
    me: {
      get: () => apiFetch<MeData>("/web/me"),
    },
    points: {
      status: () => apiFetch<PointStatusData>("/web/points"),
    },
    accounts: {
      list: () => apiFetch("/web/accounts"),
      byProvider: (query: { provider: string }) => apiFetch("/web/accounts/provider", { query }),
      byProviderDetailed: (query: { provider: string }) => apiFetch<ProviderDetailData>("/web/accounts/provider-detail", { query }),
      byProviderDetailedDelta: (query: { provider: string; cursor: string }) => apiFetch<ProviderDetailResponse>("/web/accounts/provider-detail", { query }),
      stats: (query: { accountIds: string[]; cursors?: Record<string, string> }) => apiFetch<AccountStatsData>("/web/accounts/stats", { query: cursorQuery(query.accountIds, query.cursors) }),
      overview: () => apiFetch<AccountOverviewData>("/web/accounts/overview"),
      overviewDelta: (query: { cursor: string }) => apiFetch<AccountOverviewResponse>("/web/accounts/overview", { query }),
      ping: () => apiFetch<AccountPingData>("/web/accounts/ping"),
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string; platformKey?: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/web/accounts/create", body),
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => post<ActionResult<ProviderAccountUpdateData>>(apiFetch, "/web/accounts/update", body),
      delete: (body: { id: string }) => post<ActionResult>(apiFetch, "/web/accounts/delete", body),
      togglePinned: (body: { providerKey: string }) => post<ActionResult<{ providerKey: string; pinned: boolean }>>(apiFetch, "/web/accounts/pinned", body),
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(apiFetch, "/web/accounts/model-enabled", body),
      errorHistory: (query: { accountId: string; limit?: number }) => apiFetch<ErrorHistoryResult>("/web/accounts/errors", { query }),
      errorHistories: (body: { accountIds: string[]; limit?: number }) => post<ErrorHistoryBatchResult>(apiFetch, "/web/accounts/errors/batch", body),
      resolveErrors: (body: { accountId: string }) => post<ActionResult>(apiFetch, "/web/accounts/errors/resolve", body),
      getAuthUrl: (body: { provider: OAuthProviderKey }) => post<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>(apiFetch, "/web/accounts/oauth/url", body),
      exchangeOAuth: (body: { provider: OAuthProviderKey; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/web/accounts/oauth/exchange", body),
      connectCodexSession: (body: { sessionJson: string }) => post<ActionResult<{ email: string; isUpdate: boolean }>>(apiFetch, "/web/accounts/codex-session", body),
      copySession: (body: { id: string }) => post<ActionResult<{ session: string }>>(apiFetch, "/web/accounts/session", body),
      initiateDeviceAuth: (body: { provider: DeviceProviderKey; method?: string }) => post<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string; expiresIn?: number; interval?: number }>>(apiFetch, "/web/accounts/device-auth/initiate", body),
      pollDeviceAuth: (body: { provider: DeviceProviderKey; deviceCode: string; userCode?: string; codeVerifier?: string; method?: string; machineId?: string }) => post<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>(apiFetch, "/web/accounts/device-auth/poll", body),
      quota: (body: AccountQuotaRequest, options?: ApiFetchOptions) => post<ActionResult<AccountQuotaInfo>>(apiFetch, "/web/accounts/quota", body, options),
      quotas: (body: AccountQuotaBatchRequest, options?: ApiFetchOptions) => post<ActionResult<AccountQuotaBatchResult>>(apiFetch, "/web/accounts/quotas", body, options),
    },
    customProviders: {
      list: () => apiFetch<CustomProviderListItem[]>("/web/custom-providers"),
      create: (body: { slug: string; name: string; baseUrl: string; extraHeaders?: Record<string, string> }) => post<ActionResult<CustomProviderCreateResult>>(apiFetch, "/web/custom-providers", body),
      update: (body: { slug: string; name?: string; baseUrl?: string; extraHeaders?: Record<string, string>; enabled?: boolean }) => post<ActionResult>(apiFetch, "/web/custom-providers/update", body),
      remove: (body: { slug: string }) => post<ActionResult>(apiFetch, "/web/custom-providers/delete", body),
      connect: (body: { slug: string; token: string; name?: string }) => post<ActionResult<CustomProviderConnectResult>>(apiFetch, "/web/custom-providers/connect", body),
      syncModels: (body: { slug: string; token?: string }) => post<ActionResult<CustomProviderSyncResult>>(apiFetch, "/web/custom-providers/sync-models", body),
      previewModels: (body: { baseUrl: string; extraHeaders?: Record<string, string>; token?: string }) => post<ActionResult<{ models: Array<{ modelId: string; upstream: string }> }>>(apiFetch, "/web/custom-providers/preview-models", body),
      addModels: (body: { slug: string; models: Array<{ modelId: string; upstream?: string; aliased?: boolean; authless?: boolean; minTier?: string; allowedTiers?: string[]; customFlags?: CustomProviderModelFlags }> }) => post<ActionResult<{ added: number }>>(apiFetch, "/web/custom-providers/models", body),
      deleteModel: (body: { slug: string; modelId: string }) => post<ActionResult>(apiFetch, "/web/custom-providers/models/delete", body),
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => post<AnalyticsData>(apiFetch, "/web/analytics/data", body),
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => post<AnalyticsSeriesData>(apiFetch, "/web/analytics/series", body),
      overview: () => apiFetch("/web/analytics/overview"),
      usage: (query?: { range?: string }) => apiFetch("/web/analytics/usage", { query }),
    },
    sharing: {
      get: () => apiFetch<{ enabled: boolean }>("/web/sharing"),
      update: (body: { enabled: boolean }) => post<{ enabled: boolean }>(apiFetch, "/web/sharing", body),
    },
    apiKeys: {
      list: () => apiFetch<ApiKeyListItem[]>("/web/api-keys"),
      options: () => apiFetch<ApiKeyOptions>("/web/api-keys/options"),
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => post<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>(apiFetch, "/web/api-keys/create", body),
      toggle: (body: { id: string }) => post<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>(apiFetch, "/web/api-keys/toggle", body),
      delete: (body: { id: string }) => post<ActionResult>(apiFetch, "/web/api-keys/delete", body),
      reveal: (body: { id: string }) => post<ActionResult<{ key: string }>>(apiFetch, "/web/api-keys/reveal", body),
      updateName: (body: { id: string; name: string; key?: string }) => post<ActionResult<{ name: string | null; keyPreview: string }>>(apiFetch, "/web/api-keys/name", body),
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => post<ActionResult<{ expiresAt: string | Date | null }>>(apiFetch, "/web/api-keys/expiration", body),
      updateRoaming: (body: { id: string; enabled: boolean }) => post<ActionResult<{ roamingEnabled: boolean }>>(apiFetch, "/web/api-keys/roaming", body),
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>(apiFetch, "/web/api-keys/model-access", body),
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => post<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>(apiFetch, "/web/api-keys/account-access", body),
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => post<ActionResult<{ rules: RateLimitRule[] }>>(apiFetch, "/web/api-keys/rate-limits", body),
    },
    models: {
      list: (query?: { includeStats?: boolean }) => apiFetch<ModelListItem[]>("/web/models", query ? { query } : undefined),
      search: () => apiFetch<ModelSearchItem[]>("/web/models/search"),
      catalog: () => apiFetch<string[]>("/web/models/catalog"),
      stats: (query: { models: string[]; cursors?: Record<string, string> }) => apiFetch<ModelStatsData>("/web/models/stats", { query: cursorQuery(query.models, query.cursors) }),
      familyCounts: () => apiFetch<Record<string, number>>("/web/models/families"),
      setEnabled: (body: { modelId: string; enabled: boolean }) => post<ActionResult<{ model: string; enabled: boolean }>>(apiFetch, "/web/models/enabled", body),
    },
    playground: {
      options: () => apiFetch<PlaygroundOptions>("/web/playground/options"),
      auth: (body: { endpoint: PlaygroundEndpoint }) => post<PlaygroundProxyAuth>(apiFetch, "/web/playground/auth", body),
    },
    maintainer: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => apiFetch<MaintainerAuditUserListResult>("/web/maintainer/users/search", { query }),
      },
      audit: {
        start: async (body: { userId: string }) => {
          try {
            const user = await auth.startAudit(body.userId);
            return { success: true, data: { user } } as const;
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : "Failed to start audit mode" } as const;
          }
        },
        stop: async () => {
          const stopped = await auth.stopAudit();
          return stopped ? ({ success: true, data: {} } as const) : ({ success: false, error: "Failed to stop audit mode" } as const);
        },
      },
    },
  };
}
