import type { ModelStats } from "./model-stats";
import type { ProviderAccountKey } from "./provider-accounts";
import type { ModelMeta } from "./model-capabilities";

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

export type DashboardUserRole = "user" | "maintener";

export interface DashboardUserIdentity {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface DashboardAuditInfo {
  active: boolean;
  readonly: boolean;
  user: DashboardUserIdentity | null;
}

export interface DashboardMeData {
  role: DashboardUserRole;
  isMaintener: boolean;
  points?: {
    balance: number;
  };
  sharing?: {
    enabled: boolean;
  };
  actor?: DashboardUserIdentity;
  audit?: DashboardAuditInfo;
}

export interface PointStatusData {
  balance: number;
  roamingPointsByApiKeyId: Record<string, number>;
}

export type MaintenerAuditUser = DashboardUserIdentity;

export type MaintenerAuditSearchUser = DashboardUserIdentity & {
  hasProviderIssue: boolean;
};

export interface MaintenerAuditUserListResult {
  users: MaintenerAuditSearchUser[];
  hasMore: boolean;
  nextOffset: number;
}

export interface ProviderStats {
  totalRequests: number;
  totalTokens: number;
  successRate: number | null;
  dailyRequests: Array<{ date: string; count: number }>;
  avgDurationLastDay: number | null;
  durationLast24Hours: Array<{ time: string; avgDuration: number | null }>;
}

export interface ProviderAccountItem {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  isActive: boolean;
  disabledUntil: string | Date | null;
  lastUsedAt: string | Date | null;
  expiresAt: string | Date;
  requestCount: number;
  tier: string | null;
  status: string;
  statusChangedAt: string | Date | null;
  errorCount: number;
  consecutiveErrors: number;
  lastErrorAt: string | Date | null;
  lastSuccessAt: string | Date | null;
  lastRecoveredByRotationAt: string | Date | null;
  lastErrorMessage: string | null;
  lastErrorCode: number | null;
  successCount: number;
  createdAt: string | Date;
}

export interface ProviderAccountDetailItem extends ProviderAccountItem {
  stats: ProviderStats;
}

export type ProviderAccountUpdateData = Pick<ProviderAccountItem, "id" | "name" | "isActive" | "disabledUntil" | "status" | "statusChangedAt" | "consecutiveErrors">;

export interface ProviderAccountModelHealthItem {
  status: string;
  consecutiveErrors: number;
  lastErrorAt: string | Date | null;
  lastSuccessAt: string | Date | null;
}

export interface AccountOverviewData {
  summaries: Record<ProviderAccountKey, { connected: number; active: number; indicator: "normal" | "warning" | "error"; stats: ProviderStats }>;
  pinnedProviders: ProviderAccountKey[];
  cursor?: string;
}

export interface AccountOverviewDeltaData {
  delta: true;
  cursor: string;
  summaries?: Partial<AccountOverviewData["summaries"]>;
  pinnedProviders?: ProviderAccountKey[];
}

export type AccountOverviewResponse = AccountOverviewData | AccountOverviewDeltaData;

export interface AccountPingData {
  summaries: Partial<Record<ProviderAccountKey, { active: number; indicator: "normal" | "warning" | "error" }>>;
  pinnedProviders: ProviderAccountKey[];
  hasConnectedAccounts: boolean;
}

export interface AccountStatsData {
  delta: true;
  cursors: Record<string, string>;
  stats?: Record<string, ProviderStats>;
}

export interface ProviderDetailData {
  accounts: ProviderAccountDetailItem[];
  supportedModels: string[];
  disabledModelsByAccountId: Record<string, string[]>;
  modelHealthByAccountId: Record<string, Record<string, ProviderAccountModelHealthItem>>;
  pinnedProviders: ProviderAccountKey[];
  cursor?: string;
}

export interface ProviderDetailDeltaData {
  delta: true;
  cursor: string;
  accounts?: ProviderAccountDetailItem[];
  deletedAccountIds?: string[];
  supportedModels?: string[];
  disabledModelsByAccountId?: Record<string, string[]>;
  clearedDisabledModelsByAccountId?: string[];
  modelHealthByAccountId?: Record<string, Record<string, ProviderAccountModelHealthItem>>;
  clearedModelHealthByAccountId?: string[];
  pinnedProviders?: ProviderAccountKey[];
}

export type ProviderDetailResponse = ProviderDetailData | ProviderDetailDeltaData;

export type QuotaProviderKey = "antigravity" | "copilot" | "codex" | "gemini_cli" | "kiro" | "openrouter";

export interface QuotaGroupDisplay {
  name: string;
  displayName: string;
  remainingFraction: number;
  remainingRequests: number;
  maxRequests: number;
  usedRequests: number;
  resetTimeIso: string | null;
  resetInHuman: string | null;
}

export interface AccountQuotaInfo {
  tier: string;
  status: "success" | "error" | "expired";
  error?: string;
  groups: QuotaGroupDisplay[];
}

export interface AccountQuotaRequest {
  provider: QuotaProviderKey;
  accountId: string;
  forceRefresh?: boolean;
}

export interface AccountQuotaBatchRequest {
  provider: QuotaProviderKey;
  accountIds: string[];
  forceRefresh?: boolean;
}

export type AccountQuotaBatchResult = Record<string, ActionResult<AccountQuotaInfo>>;

export interface ErrorHistoryEntry {
  id: string;
  model: string | null;
  errorCode: number | null;
  errorMessage: string;
  createdAt: string | Date;
}

export type ErrorHistoryResult = ActionResult<{ entries: ErrorHistoryEntry[] }>;

export interface ApiKeyListItem {
  id: string;
  name: string | null;
  keyPreview: string;
  isActive: boolean;
  createdAt: string | Date;
  expiresAt: string | Date | null;
  lastUsedAt: string | Date | null;
  modelAccessMode: string;
  modelAccessList: string[];
  accountAccessMode: string;
  accountAccessList: string[];
  roamingEnabled: boolean;
  roamingPointsUsed: number;
}

export interface ApiKeyOptions {
  availableModels: string[];
  availableFamilies: string[];
  providerAccounts: Array<{ id: string; provider: string; name: string; email: string | null; supportedModels?: string[] | null }>;
  rateLimitsByKeyId: Record<string, Array<{ target: string; targetType: "model" | "family"; perMinute: number | null; perHour: number | null; perDay: number | null }>>;
}

export interface ModelListItem {
  id: string;
  name: string;
  family: string;
  providers: string[];
  meta?: ModelMeta;
  isEnabled: boolean;
  stats?: ModelStats;
}

export interface ModelStatsData {
  delta: true;
  cursors: Record<string, string>;
  stats?: Record<string, ModelStats>;
}

export type ModelSearchItem = Omit<ModelListItem, "name" | "family" | "stats">;

export interface PlaygroundOptions {
  proxyBaseUrl?: string;
  hasAnyProviderAccount: boolean;
  models: Array<{ id: string; name: string; family: string; providers: string[]; meta?: ModelMeta }>;
  providerAccounts: Array<{ id: string; provider: string; name: string; email: string | null; isActive: boolean; disabledUntil: string | Date | null; disabledModels: string[]; supportedModels?: string[] | null }>;
}

export interface PlaygroundProxyAuth {
  headers: Record<string, string>;
}

export type Period = "5m" | "15m" | "30m" | "1h" | "6h" | "24h" | "7d" | "30d" | "90d";
export type AnalyticsFilter = Period | { from: string; to: string };

export interface AnalyticsData {
  requestsOverTime: Array<{ date: string; count: number }>;
  tokenUsage: Array<{ date: string; input: number; output: number }>;
  requestsByModel: Array<{ model: string; count: number }>;
  modelDistribution: Array<{ model: string; value: number; percentage: number }>;
  successRate: Array<{ date: string; success: number; error: number; successRate?: number; errorRate?: number }>;
  durationOverTime: Array<{ date: string; avg: number | null; p30: number | null; p50: number | null; p60: number | null; p75: number | null; p90: number | null; p95: number | null; p99: number | null }>;
  granularity: "10s" | "1m" | "5m" | "15m" | "1h" | "1d";
  totals: {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgDuration: number;
    durationPercentiles: { p30: number; p50: number; p60: number; p75: number; p90: number; p95: number; p99: number };
    successRate: number;
  };
}

export type AnalyticsSeriesData = Pick<AnalyticsData, "requestsOverTime" | "tokenUsage" | "successRate" | "durationOverTime" | "granularity">;
