import type { AuthService } from "@opendum/auth";
import type { ProxyService } from "@opendum/api/core/service";
import type { Registry } from "@opendum/models/runtime";
import type * as accountsService from "@opendum/api/web/services/accounts";
import type * as accountAuthService from "@opendum/api/web/services/account-auth";
import type * as accountQuotaService from "@opendum/api/web/services/account-quota";
import type * as analyticsService from "@opendum/api/web/services/analytics";
import type * as apiKeysService from "@opendum/api/web/services/api-keys";
import type * as customProvidersService from "@opendum/api/web/services/custom-providers";
import type * as modelsService from "@opendum/api/web/services/models";
import type * as pointsService from "@opendum/api/web/services/points";
import type * as sharingService from "@opendum/api/web/services/sharing";

export type McpModels = Pick<Registry, "openAiModels" | "resolveAlias" | "modelFamily" | "modelCost">;

export type McpAuth = Pick<
  AuthService,
  "validateKey" | "disabledModels" | "availability" | "usable" | "usableShared" | "list"
>;

export type McpService = Pick<ProxyService, "handle">;

export type McpWebServices = {
  models: Pick<
    typeof modelsService,
    "listModels" | "searchModels" | "knownModels" | "getModelStats" | "familyCounts" | "enableModel"
  >;
  analytics: Pick<
    typeof analyticsService,
    "getAnalyticsData" | "getAnalyticsSeries" | "getAnalyticsOverview" | "getUsageRows"
  >;
  apiKeys: Pick<
    typeof apiKeysService,
    | "listApiKeys"
    | "getOptions"
    | "createApiKey"
    | "toggleApiKey"
    | "deleteApiKey"
    | "revealApiKey"
    | "updateName"
    | "updateExpiration"
    | "updateRoaming"
    | "updateModels"
    | "updateAccess"
    | "updateRateLimits"
  >;
  accounts: Pick<
    typeof accountsService,
    | "listAccounts"
    | "listByProvider"
    | "getAccountOverview"
    | "getAccountPing"
    | "accountsDetailed"
    | "getAccountStats"
    | "updateAccount"
    | "deleteAccount"
    | "togglePinnedProvider"
    | "enableModel"
    | "errorHistory"
    | "errorHistories"
    | "resolveAccountErrors"
    | "createAccount"
  >;
  accountQuota: Pick<typeof accountQuotaService, "getAccountQuota" | "getAccountQuotas">;
  accountAuth: Pick<
    typeof accountAuthService,
    "authUrlFor" | "exchangeAccount" | "connectCodex" | "initiateDeviceAuth" | "pollAuth"
  >;
  customProviders: Pick<
    typeof customProvidersService,
    | "listCustomProviders"
    | "customProviderModels"
    | "createCustomProvider"
    | "updateCustomProvider"
    | "deleteCustomProvider"
    | "connectCustom"
    | "syncCustomModels"
    | "previewCustomModels"
    | "upsertCustomModels"
    | "deleteCustomModel"
  >;
  points: Pick<typeof pointsService, "pointStatus" | "claimDaily">;
  sharing: Pick<typeof sharingService, "sharingEnabled" | "setSharing">;
};

export type McpContext = {
  models: McpModels;
  auth: McpAuth;
  service: McpService;
  web: McpWebServices;
};
