import type {
  AccountOverviewData,
  AccountPingData,
  AccountStatsData,
  ActionResult,
  AnalyticsData,
  AnalyticsFilter,
  AnalyticsSeriesData,
  MeData,
  AuditListResult,
  QuotaBatchRequest,
  KeyListItem,
  ApiKeyOptions,
  HistoryBatchResult,
  ErrorHistoryResult,
  QuotaBatchResult,
  AccountQuotaInfo,
  AccountQuotaRequest,
  CustomListItem,
  CustomCreateResult,
  CustomSyncResult,
  CustomConnectResult,
  CustomModelFlags,
  PointStatusData,
  PlaygroundOptions,
  PlaygroundProxyAuth,
  ProviderDetailData,
  AccountUpdateData,
} from "../../lib/api-types";
import type { DeviceProviderKey, AuthProvider } from "@opendum/providers/provider-accounts";
import type { AccessMode } from "../../lib/access-draft";
import { apiUrl } from "../../lib/api-url";
import { apiClient } from "../../lib/orpc";

type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";
type RateLimitRule = { target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null };

export function useApi() {
  const config = useRuntimeConfig();
  const auth = useAuth();
  const refreshAuth = async () => {
    if (await auth.refreshAccessToken()) return true;

    auth.expireSession();
    void navigateTo("/");
    return false;
  };
  const baseUrl = apiUrl(config.public.apiUrl);
  const rpc = apiClient({ baseUrl, refresh: refreshAuth });

  return {
    me: {
      get: () => rpc.session.get({}) as Promise<MeData>,
    },
    points: {
      status: () => rpc.points.get({}) as Promise<PointStatusData>,
    },
    accounts: {
      list: () => rpc.accounts.list({}),
      byProvider: (query: { provider: string }) => rpc.accounts.provider(query),
      byProviderDetailed: (query: { provider: string }) => rpc.accounts.detail(query) as Promise<ProviderDetailData>,
      stats: (query: { accountIds: string[] }) => rpc.accounts.stats(query) as Promise<AccountStatsData>,
      overview: () => rpc.accounts.overview({}) as Promise<AccountOverviewData>,
      ping: () => rpc.accounts.ping({}) as Promise<AccountPingData>,
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string; platformKey?: string }) => rpc.accounts.create(body) as Promise<ActionResult<{ email: string; isUpdate: boolean }>>,
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => rpc.accounts.update(body) as Promise<ActionResult<AccountUpdateData>>,
      delete: (body: { id: string }) => rpc.accounts.delete(body) as Promise<ActionResult>,
      togglePinned: (body: { providerKey: string }) => rpc.accounts.pin(body) as Promise<ActionResult<{ providerKey: string; pinned: boolean }>>,
      enableModel: (body: { accountId: string; modelId: string; enabled: boolean }) => rpc.accounts.enable(body) as Promise<ActionResult<{ model: string; enabled: boolean }>>,
      errorHistory: (query: { accountId: string; limit?: number }) => rpc.accounts.error(query) as Promise<ErrorHistoryResult>,
      errorHistories: (body: { accountIds: string[]; limit?: number }) => rpc.accounts.errors(body) as Promise<HistoryBatchResult>,
      resolveErrors: (body: { accountId: string }) => rpc.accounts.resolve(body) as Promise<ActionResult>,
      getAuthUrl: (body: { provider: AuthProvider }) => rpc.accounts.auth(body) as Promise<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>,
      oauthExchange: (body: { provider: AuthProvider; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => rpc.accounts.exchange(body) as Promise<ActionResult<{ email: string; isUpdate: boolean }>>,
      connectCodexSession: (body: { sessionJson: string }) => rpc.accounts.codex(body) as Promise<ActionResult<{ email: string; isUpdate: boolean }>>,
      copySession: (body: { id: string }) => rpc.accounts.session(body) as Promise<ActionResult<{ session: string }>>,
      initiateDeviceAuth: (body: { provider: DeviceProviderKey; method?: string }) => rpc.accounts.initiate(body) as Promise<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string; expiresIn?: number; interval?: number }>>,
      pollAuth: (body: { provider: DeviceProviderKey; deviceCode: string; userCode?: string; codeVerifier?: string; method?: string; machineId?: string }) => rpc.accounts.poll(body) as Promise<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>,
      quota: (body: AccountQuotaRequest) => rpc.accounts.quota(body) as Promise<ActionResult<AccountQuotaInfo>>,
      quotas: (body: QuotaBatchRequest) => rpc.accounts.quotas(body) as Promise<ActionResult<QuotaBatchResult>>,
    },
    customProviders: {
      list: () => rpc.providers.list({}) as Promise<CustomListItem[]>,
      create: (body: { slug: string; name: string; baseUrl: string; extraHeaders?: Record<string, string> }) => rpc.providers.create(body) as Promise<ActionResult<CustomCreateResult>>,
      update: (body: { slug: string; name?: string; baseUrl?: string; extraHeaders?: Record<string, string>; enabled?: boolean }) => rpc.providers.update(body) as Promise<ActionResult>,
      remove: (body: { slug: string }) => rpc.providers.delete(body) as Promise<ActionResult>,
      connect: (body: { slug: string; token: string; name?: string }) => rpc.providers.connect(body) as Promise<ActionResult<CustomConnectResult>>,
      syncModels: (body: { slug: string; token?: string }) => rpc.providers.sync(body) as Promise<ActionResult<CustomSyncResult>>,
      previewModels: (body: { baseUrl: string; extraHeaders?: Record<string, string>; token?: string }) => rpc.providers.preview(body) as Promise<ActionResult<{ models: Array<{ modelId: string; upstream: string }> }>>,
      addModels: (body: { slug: string; models: Array<{ modelId: string; upstream?: string; aliased?: boolean; authless?: boolean; minTier?: string; allowedTiers?: string[]; customFlags?: CustomModelFlags }> }) => rpc.providers.models(body) as Promise<ActionResult<{ added: number }>>,
      deleteModel: (body: { slug: string; modelId: string }) => rpc.providers.model(body) as Promise<ActionResult>,
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => rpc.analytics.data(body) as Promise<AnalyticsData>,
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => rpc.analytics.series(body) as Promise<AnalyticsSeriesData>,
      overview: () => rpc.analytics.overview({}),
      usage: (query?: { range?: "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d" | "90d" }) => rpc.analytics.usage(query),
    },
    sharing: {
      get: () => rpc.sharing.get({}) as Promise<{ enabled: boolean }>,
      update: (body: { enabled: boolean }) => rpc.sharing.update(body) as Promise<{ enabled: boolean }>,
    },
    apiKeys: {
      list: () => rpc.keys.list({}) as Promise<KeyListItem[]>,
      options: () => rpc.keys.options({}) as Promise<ApiKeyOptions>,
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => rpc.keys.create(body) as Promise<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>,
      toggle: (body: { id: string }) => rpc.keys.toggle(body) as Promise<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>,
      delete: (body: { id: string }) => rpc.keys.delete(body) as Promise<ActionResult>,
      reveal: (body: { id: string }) => rpc.keys.reveal(body) as Promise<ActionResult<{ key: string }>>,
      updateName: (body: { id: string; name: string; key?: string }) => rpc.keys.rename(body) as Promise<ActionResult<{ name: string | null; keyPreview: string }>>,
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => rpc.keys.expire(body) as Promise<ActionResult<{ expiresAt: string | Date | null }>>,
      updateRoaming: (body: { id: string; enabled: boolean }) => rpc.keys.roaming(body) as Promise<ActionResult<{ roamingEnabled: boolean }>>,
      updateModelAccess: (body: { id: string; mode: AccessMode; models: string[] }) => rpc.keys.models(body) as Promise<ActionResult<{ mode: AccessMode; models: string[] }>>,
      updateAccountAccess: (body: { id: string; mode: AccessMode; accounts: string[] }) => rpc.keys.accounts(body) as Promise<ActionResult<{ mode: AccessMode; accounts: string[] }>>,
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => rpc.keys.limits(body) as Promise<ActionResult<{ rules: RateLimitRule[] }>>,
    },
    models: {
      list: (query?: { includeStats?: boolean }) => rpc.models.list({ includeStats: query?.includeStats }),
      search: () => rpc.models.search(),
      catalog: () => rpc.models.catalog(),
      stats: (query: { models: string[] }) => rpc.models.stats(query),
      familyCounts: () => rpc.models.families(),
      setEnabled: (body: { modelId: string; enabled: boolean }) => rpc.models.enable(body),
    },
    playground: {
      options: () => rpc.playground.options({}) as Promise<PlaygroundOptions>,
      auth: (body: { endpoint: PlaygroundEndpoint }) => rpc.playground.auth(body) as Promise<PlaygroundProxyAuth>,
    },
    maintainer: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => rpc.admin.users(query ?? {}) as Promise<AuditListResult>,
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
