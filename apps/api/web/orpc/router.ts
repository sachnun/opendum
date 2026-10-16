import { ORPCError } from "@orpc/server";
import { contract } from "@opendum/providers/contract";
import { playgroundSignature } from "@opendum/core/crypto";
import { implement } from "@orpc/server";
import { Effect } from "effect";

import { getProxyContext } from "../../context.js";
import { publishModelsChanged, subscribeUserEvents } from "#web/events/bus.js";
import "#web/events/snapshots.js";
import { requestOriginFromHeaders } from "#web/lib/request-origin.js";
import * as accountAuth from "#web/services/account-auth.js";
import * as accountQuota from "#web/services/account-quota.js";
import * as accounts from "#web/services/accounts.js";
import * as analytics from "#web/services/analytics.js";
import * as apiKeys from "#web/services/api-keys.js";
import * as customProviders from "#web/services/custom-providers.js";
import * as maintainer from "#web/services/maintainer.js";
import * as models from "#web/services/models.js";
import * as ops from "#web/services/ops.js";
import { getPlaygroundOptions } from "#web/services/playground.js";
import { claimDailyAccessPoints, getUserPointStatus } from "#web/services/points.js";
import { getUserSharingEnabled, setUserSharingEnabled } from "#web/services/sharing.js";
import { requireMaintainer, requireWritable, resolveRequestContext, type OrpcInitialContext } from "./context.js";

const base = implement(contract).$context<OrpcInitialContext>();

const authed = base.use(async ({ context, next }) => {
  const requestContext = await Effect.runPromise(resolveRequestContext(context.headers));
  return next({ context: { ...context, requestContext } });
});

const writable = authed.use(async ({ context, next }) => {
  await Effect.runPromise(requireWritable(context.requestContext));
  return next({ context });
});

const maintainerOnly = authed.use(async ({ context, next }) => {
  await Effect.runPromise(requireMaintainer(context.requestContext));
  return next({ context });
});

function playgroundEndpointPath(endpoint: "chat_completions" | "messages" | "responses"): string {
  if (endpoint === "messages") return "/v1/messages";
  if (endpoint === "responses") return "/v1/responses";
  return "/v1/chat/completions";
}

export const router = authed.router({
  models: {
    list: authed.models.list.handler(({ context, input }) => models.listModels(context.requestContext.userId, input ?? {})),
    search: authed.models.search.handler(({ context }) => models.searchModels(context.requestContext.userId)),
    catalog: authed.models.catalog.handler(() => models.listKnownModels()),
    families: authed.models.families.handler(() => models.getModelFamilyCounts()),
    stats: authed.models.stats.handler(({ context, input }) => models.getModelStats(context.requestContext.userId, input)),
    enable: writable.models.enable.handler(({ context, input }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => models.setModelEnabled(context.requestContext.userId, input));
          if (result.success) yield* Effect.sync(() => publishModelsChanged(context.requestContext.userId));
          return result;
        })
      )
    ),
  },
  events: {
    subscribe: authed.events.subscribe.handler(({ context, input, signal }) =>
      subscribeUserEvents(context.requestContext.userId, input.topics, signal)
    ),
  },
  admin: {
    quota: maintainerOnly.admin.quota.handler(async ({ input }) => ops.runOpsAccountQuota(await getProxyContext(), input)),
    relay: maintainerOnly.admin.relay.handler(async ({ input }) => ops.runOpsRelay(await getProxyContext(), input)),
    users: maintainerOnly.admin.users.handler(({ context, input }) => maintainer.searchAuditUsers(context.requestContext.actor.id, input)),
  },
  accounts: {
    list: authed.accounts.list.handler(({ context }) => accounts.listAccounts(context.requestContext.userId)),
    overview: authed.accounts.overview.handler(({ context }) =>
      accounts.getAccountOverview(context.requestContext.userId, { autoPin: !context.requestContext.isAuditMode })
    ),
    ping: authed.accounts.ping.handler(({ context }) =>
      accounts.getAccountPing(context.requestContext.userId, { autoPin: !context.requestContext.isAuditMode })
    ),
    provider: authed.accounts.provider.handler(({ context, input }) => accounts.listAccountsByProvider(context.requestContext.userId, input)),
    detail: authed.accounts.detail.handler(({ context, input }) =>
      accounts.getAccountsByProviderDetailed(context.requestContext.userId, input)
    ),
    stats: authed.accounts.stats.handler(({ context, input }) =>
      accounts.getAccountStats(context.requestContext.userId, { accountIds: input.accountIds })
    ),
    create: writable.accounts.create.handler(({ context, input }) => accounts.createAccount(context.requestContext.userId, input)),
    update: writable.accounts.update.handler(({ context, input }) => accounts.updateAccount(context.requestContext.userId, input)),
    delete: writable.accounts.delete.handler(({ context, input }) => accounts.deleteAccount(context.requestContext.userId, input)),
    pin: writable.accounts.pin.handler(({ context, input }) => accounts.togglePinnedProvider(context.requestContext.userId, input)),
    enable: writable.accounts.enable.handler(({ context, input }) =>
      accounts.setAccountModelEnabled(context.requestContext.userId, input)
    ),
    error: authed.accounts.error.handler(({ context, input }) => accounts.getAccountErrorHistory(context.requestContext.userId, input)),
    errors: authed.accounts.errors.handler(({ context, input }) =>
      accounts.getAccountErrorHistories(context.requestContext.userId, input)
    ),
    resolve: authed.accounts.resolve.handler(({ context, input }) => accounts.resolveAccountErrors(context.requestContext.userId, input)),
    session: writable.accounts.session.handler(({ context, input }) => {
      if (process.env.NODE_ENV === "production" && !context.requestContext.isMaintainer) {
        throw new ORPCError("NOT_FOUND", { message: "Not Found" });
      }
      return accounts.getAccountSession(context.requestContext.userId, input);
    }),
    auth: writable.accounts.auth.handler(({ input }) => accountAuth.getAccountAuthUrl(input)),
    exchange: writable.accounts.exchange.handler(({ context, input }) =>
      accountAuth.exchangeOAuthAccount(context.requestContext.userId, input)
    ),
    initiate: writable.accounts.initiate.handler(({ input }) => accountAuth.initiateDeviceAuth(input)),
    poll: writable.accounts.poll.handler(({ context, input }) => accountAuth.pollDeviceAuth(context.requestContext.userId, input)),
    codex: writable.accounts.codex.handler(({ context, input }) =>
      accountAuth.connectCodexSessionAccount(context.requestContext.userId, input)
    ),
    quota: authed.accounts.quota.handler(({ context, input }) =>
      accountQuota.getAccountQuota(context.requestContext.userId, { ...input, forceRefresh: input.forceRefresh ?? false })
    ),
    quotas: authed.accounts.quotas.handler(({ context, input }) =>
      accountQuota.getAccountQuotas(context.requestContext.userId, { ...input, forceRefresh: input.forceRefresh ?? false })
    ),
  },
  keys: {
    list: authed.keys.list.handler(({ context }) =>
      apiKeys.listApiKeys(context.requestContext.userId, { expireActiveKeys: !context.requestContext.isAuditMode })
    ),
    options: authed.keys.options.handler(({ context }) => apiKeys.getApiKeyOptions(context.requestContext.userId)),
    create: writable.keys.create.handler(({ context, input }) => apiKeys.createApiKey(context.requestContext.userId, input)),
    delete: writable.keys.delete.handler(({ context, input }) => apiKeys.deleteApiKey(context.requestContext.userId, input.id)),
    rename: writable.keys.rename.handler(({ context, input }) => apiKeys.updateApiKeyName(context.requestContext.userId, input)),
    expire: writable.keys.expire.handler(({ context, input }) => apiKeys.updateApiKeyExpiration(context.requestContext.userId, input)),
    roaming: writable.keys.roaming.handler(({ context, input }) => apiKeys.updateApiKeyRoaming(context.requestContext.userId, input)),
    models: writable.keys.models.handler(({ context, input }) => apiKeys.updateApiKeyModelAccess(context.requestContext.userId, input)),
    accounts: writable.keys.accounts.handler(({ context, input }) => apiKeys.updateApiKeyAccountAccess(context.requestContext.userId, input)),
    limits: writable.keys.limits.handler(({ context, input }) => apiKeys.updateApiKeyRateLimits(context.requestContext.userId, input)),
    reveal: writable.keys.reveal.handler(({ context, input }) => apiKeys.revealApiKey(context.requestContext.userId, input.id)),
    toggle: writable.keys.toggle.handler(({ context, input }) => apiKeys.toggleApiKey(context.requestContext.userId, input.id)),
  },
  providers: {
    list: authed.providers.list.handler(({ context }) => customProviders.listCustomProviders(context.requestContext.userId)),
    create: writable.providers.create.handler(({ context, input }) => customProviders.createCustomProvider(context.requestContext.userId, input)),
    update: writable.providers.update.handler(({ context, input }) => customProviders.updateCustomProvider(context.requestContext.userId, input)),
    delete: writable.providers.delete.handler(({ context, input }) => customProviders.deleteCustomProvider(context.requestContext.userId, input.slug)),
    connect: writable.providers.connect.handler(({ context, input }) =>
      customProviders.connectCustomProviderAccount(context.requestContext.userId, input.slug, input.token, input.name)
    ),
    sync: writable.providers.sync.handler(({ context, input }) =>
      customProviders.syncCustomModels(context.requestContext.userId, input.slug, input.token)
    ),
    preview: writable.providers.preview.handler(({ input }) => customProviders.previewCustomModels(input)),
    models: writable.providers.models.handler(({ context, input }) =>
      customProviders.upsertCustomModels(context.requestContext.userId, input.slug, input.models)
    ),
    model: writable.providers.model.handler(({ context, input }) =>
      customProviders.deleteCustomModel(context.requestContext.userId, input.slug, input.modelId)
    ),
  },
  analytics: {
    data: authed.analytics.data.handler(({ context, input }) => analytics.getAnalyticsData(context.requestContext.userId, input)),
    series: authed.analytics.series.handler(({ context, input }) => analytics.getAnalyticsSeries(context.requestContext.userId, input)),
    overview: authed.analytics.overview.handler(({ context }) => analytics.getAnalyticsOverview(context.requestContext.userId)),
    usage: authed.analytics.usage.handler(({ context, input }) => analytics.getUsageRows(context.requestContext.userId, input)),
  },
  session: {
    get: authed.session.get.handler(async ({ context }) => {
      const requestContext = context.requestContext;
      const [pointStatus, sharingEnabled] = await Promise.all([
        getUserPointStatus(requestContext.userId),
        getUserSharingEnabled(requestContext.userId),
      ]);

      return {
        role: requestContext.role,
        isMaintainer: requestContext.isMaintainer,
        points: { balance: pointStatus.balance, roamingPointsByApiKeyId: pointStatus.roamingPointsByApiKeyId },
        sharing: { enabled: sharingEnabled },
        actor: requestContext.actor,
        audit: { active: requestContext.isAuditMode, readonly: requestContext.isAuditMode, user: requestContext.auditUser },
      };
    }),
  },
  points: {
    get: authed.points.get.handler(async ({ context }) => {
      const requestContext = context.requestContext;
      try {
        await claimDailyAccessPoints(requestContext.actor.id);
      } catch (error) {
        console.error("Failed to claim daily access points:", error);
      }

      return getUserPointStatus(requestContext.userId);
    }),
  },
  sharing: {
    get: authed.sharing.get.handler(({ context }) => getUserSharingEnabled(context.requestContext.userId)),
    update: writable.sharing.update.handler(({ context, input }) => setUserSharingEnabled(context.requestContext.userId, input.enabled)),
  },
  playground: {
    options: authed.playground.options.handler(({ context }) =>
      getPlaygroundOptions(context.requestContext.userId, requestOriginFromHeaders(context.headers, context.url))
    ),
    auth: authed.playground.auth.handler(({ context, input }) => {
      const requestContext = context.requestContext;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const method = "POST";
      const path = playgroundEndpointPath(input.endpoint);
      const secret = process.env.BETTER_AUTH_SECRET;
      if (!secret) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "BETTER_AUTH_SECRET is required" });

      return {
        headers: {
          "X-Opendum-Playground-User-Id": requestContext.userId,
          "X-Opendum-Playground-Timestamp": timestamp,
          "X-Opendum-Playground-Signature": playgroundSignature(secret, requestContext.userId, timestamp, method, path),
        },
      };
    }),
  },
});
