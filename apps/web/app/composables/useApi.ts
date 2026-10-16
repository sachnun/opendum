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
  PointStatusData,
  PlaygroundOptions,
  PlaygroundProxyAuth,
  ProviderDetailData,
  ProviderDetailResponse,
  ProviderAccountUpdateData,
} from "../../lib/api-types";
import type { DeviceProviderKey, OAuthProviderKey } from "@opendum/providers/provider-accounts";
import { resolveApiUrl } from "../../lib/api-url";
import { createApiClient } from "../../lib/orpc";

type ApiKeyAccessMode = "all" | "whitelist" | "blacklist";
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
  const baseUrl = resolveApiUrl(config.public.apiUrl);
  const rpc = createApiClient({ baseUrl, refresh: refreshAuth });

  return {
    me: {
      get: () => rpc.me.get({}) as Promise<MeData>,
    },
    points: {
      status: () => rpc.points.status({}) as Promise<PointStatusData>,
    },
    accounts: {
      list: () => rpc.accounts.list({}),
      byProvider: (query: { provider: string }) => rpc.accounts.provider(query),
      byProviderDetailed: (query: { provider: string }) => rpc.accounts.providerDetail(query) as Promise<ProviderDetailData>,
      byProviderDetailedDelta: (query: { provider: string; cursor: string }) => rpc.accounts.providerDetail(query) as Promise<ProviderDetailResponse>,
      stats: (query: { accountIds: string[]; cursors?: Record<string, string> }) => rpc.accounts.stats(query) as Promise<AccountStatsData>,
      overview: () => rpc.accounts.overview({}) as Promise<AccountOverviewData>,
      overviewDelta: (query: { cursor: string }) => rpc.accounts.overview(query) as Promise<AccountOverviewResponse>,
      ping: () => rpc.accounts.ping({}) as Promise<AccountPingData>,
      create: (body: { provider: string; name?: string; token: string; cfAccountId?: string; platformKey?: string }) => rpc.accounts.create(body) as Promise<ActionResult<{ email: string; isUpdate: boolean }>>,
      update: (body: { id: string; name?: string; isActive?: boolean; disabledUntil?: string | Date | null }) => rpc.accounts.update(body) as Promise<ActionResult<ProviderAccountUpdateData>>,
      delete: (body: { id: string }) => rpc.accounts.remove(body) as Promise<ActionResult>,
      togglePinned: (body: { providerKey: string }) => rpc.accounts.pinned(body) as Promise<ActionResult<{ providerKey: string; pinned: boolean }>>,
      setAccountModelEnabled: (body: { accountId: string; modelId: string; enabled: boolean }) => rpc.accounts.setModelEnabled(body) as Promise<ActionResult<{ model: string; enabled: boolean }>>,
      errorHistory: (query: { accountId: string; limit?: number }) => rpc.accounts.errorHistory(query) as Promise<ErrorHistoryResult>,
      errorHistories: (body: { accountIds: string[]; limit?: number }) => rpc.accounts.errorHistories(body) as Promise<ErrorHistoryBatchResult>,
      resolveErrors: (body: { accountId: string }) => rpc.accounts.resolveErrors(body) as Promise<ActionResult>,
      getAuthUrl: (body: { provider: OAuthProviderKey }) => rpc.accounts.authUrl(body) as Promise<ActionResult<{ authUrl: string; state: string | null; codeVerifier: string | null }>>,
      exchangeOAuth: (body: { provider: OAuthProviderKey; callbackUrl: string; state?: string | null; codeVerifier?: string | null }) => rpc.accounts.exchangeOAuth(body) as Promise<ActionResult<{ email: string; isUpdate: boolean }>>,
      connectCodexSession: (body: { sessionJson: string }) => rpc.accounts.connectCodexSession(body) as Promise<ActionResult<{ email: string; isUpdate: boolean }>>,
      copySession: (body: { id: string }) => rpc.accounts.session(body) as Promise<ActionResult<{ session: string }>>,
      initiateDeviceAuth: (body: { provider: DeviceProviderKey; method?: string }) => rpc.accounts.initiateDeviceAuth(body) as Promise<ActionResult<{ deviceCode: string; userCode: string; verificationUrl: string; verificationUrlComplete?: string; codeVerifier?: string; machineId?: string; expiresIn?: number; interval?: number }>>,
      pollDeviceAuth: (body: { provider: DeviceProviderKey; deviceCode: string; userCode?: string; codeVerifier?: string; method?: string; machineId?: string }) => rpc.accounts.pollDeviceAuth(body) as Promise<ActionResult<{ status: "pending"; retryAfterSeconds?: number } | { status: "error"; message: string } | { status: "success"; email: string; isUpdate: boolean }>>,
      quota: (body: AccountQuotaRequest) => rpc.accounts.quota(body) as Promise<ActionResult<AccountQuotaInfo>>,
      quotas: (body: AccountQuotaBatchRequest) => rpc.accounts.quotas(body) as Promise<ActionResult<AccountQuotaBatchResult>>,
    },
    customProviders: {
      list: () => rpc.customProviders.list({}) as Promise<CustomProviderListItem[]>,
      create: (body: { slug: string; name: string; baseUrl: string; extraHeaders?: Record<string, string> }) => rpc.customProviders.create(body) as Promise<ActionResult<CustomProviderCreateResult>>,
      update: (body: { slug: string; name?: string; baseUrl?: string; extraHeaders?: Record<string, string>; enabled?: boolean }) => rpc.customProviders.update(body) as Promise<ActionResult>,
      remove: (body: { slug: string }) => rpc.customProviders.remove(body) as Promise<ActionResult>,
      connect: (body: { slug: string; token: string; name?: string }) => rpc.customProviders.connect(body) as Promise<ActionResult<CustomProviderConnectResult>>,
      syncModels: (body: { slug: string; token?: string }) => rpc.customProviders.syncModels(body) as Promise<ActionResult<CustomProviderSyncResult>>,
      previewModels: (body: { baseUrl: string; extraHeaders?: Record<string, string>; token?: string }) => rpc.customProviders.previewModels(body) as Promise<ActionResult<{ models: Array<{ modelId: string; upstream: string }> }>>,
      addModels: (body: { slug: string; models: Array<{ modelId: string; upstream?: string; aliased?: boolean; authless?: boolean; minTier?: string; allowedTiers?: string[]; customFlags?: CustomProviderModelFlags }> }) => rpc.customProviders.upsertModels(body) as Promise<ActionResult<{ added: number }>>,
      deleteModel: (body: { slug: string; modelId: string }) => rpc.customProviders.deleteModel(body) as Promise<ActionResult>,
    },
    analytics: {
      data: (body?: { filter?: AnalyticsFilter; apiKeyId?: string; includeSeries?: boolean }) => rpc.analytics.data(body) as Promise<AnalyticsData>,
      series: (body?: { filter?: AnalyticsFilter; apiKeyId?: string }) => rpc.analytics.series(body) as Promise<AnalyticsSeriesData>,
      overview: () => rpc.analytics.overview({}),
      usage: (query?: { range?: "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d" | "90d" }) => rpc.analytics.usage(query),
    },
    sharing: {
      get: () => rpc.sharing.get({}) as Promise<{ enabled: boolean }>,
      update: (body: { enabled: boolean }) => rpc.sharing.set(body) as Promise<{ enabled: boolean }>,
    },
    apiKeys: {
      list: () => rpc.apiKeys.list({}) as Promise<ApiKeyListItem[]>,
      options: () => rpc.apiKeys.options({}) as Promise<ApiKeyOptions>,
      create: (body?: { name?: string; expiresAt?: Date | string | null }) => rpc.apiKeys.create(body) as Promise<ActionResult<{ id: string; key: string; keyPreview: string; name: string | null; expiresAt: string | Date | null }>>,
      toggle: (body: { id: string }) => rpc.apiKeys.toggle(body) as Promise<ActionResult<{ id: string; isActive: boolean; expiresAt: string | Date | null }>>,
      delete: (body: { id: string }) => rpc.apiKeys.remove(body) as Promise<ActionResult>,
      reveal: (body: { id: string }) => rpc.apiKeys.reveal(body) as Promise<ActionResult<{ key: string }>>,
      updateName: (body: { id: string; name: string; key?: string }) => rpc.apiKeys.name(body) as Promise<ActionResult<{ name: string | null; keyPreview: string }>>,
      updateExpiration: (body: { id: string; expiresAt: Date | string | null }) => rpc.apiKeys.expiration(body) as Promise<ActionResult<{ expiresAt: string | Date | null }>>,
      updateRoaming: (body: { id: string; enabled: boolean }) => rpc.apiKeys.roaming(body) as Promise<ActionResult<{ roamingEnabled: boolean }>>,
      updateModelAccess: (body: { id: string; mode: ApiKeyAccessMode; models: string[] }) => rpc.apiKeys.modelAccess(body) as Promise<ActionResult<{ mode: ApiKeyAccessMode; models: string[] }>>,
      updateAccountAccess: (body: { id: string; mode: ApiKeyAccessMode; accounts: string[] }) => rpc.apiKeys.accountAccess(body) as Promise<ActionResult<{ mode: ApiKeyAccessMode; accounts: string[] }>>,
      updateRateLimits: (body: { id: string; rules: RateLimitRule[] }) => rpc.apiKeys.rateLimits(body) as Promise<ActionResult<{ rules: RateLimitRule[] }>>,
    },
    models: {
      list: (query?: { includeStats?: boolean }) => rpc.models.list({ includeStats: query?.includeStats }),
      search: () => rpc.models.search(),
      catalog: () => rpc.models.catalog(),
      stats: (query: { models: string[]; cursors?: Record<string, string> }) => rpc.models.stats(query),
      familyCounts: () => rpc.models.familyCounts(),
      setEnabled: (body: { modelId: string; enabled: boolean }) => rpc.models.setEnabled(body),
    },
    playground: {
      options: () => rpc.playground.options({}) as Promise<PlaygroundOptions>,
      auth: (body: { endpoint: PlaygroundEndpoint }) => rpc.playground.auth(body) as Promise<PlaygroundProxyAuth>,
    },
    maintainer: {
      users: {
        search: (query?: { q?: string; offset?: number; limit?: number }) => rpc.maintainer.users.search(query ?? {}) as Promise<MaintainerAuditUserListResult>,
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
