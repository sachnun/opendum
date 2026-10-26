import { ORPCError } from "@orpc/server";
import { contract } from "@opendum/providers/contract";
import { playgroundSignature } from "@opendum/core/crypto";
import { implement } from "@orpc/server";
import { Effect } from "effect";
import { raise } from "@opendum/core/raise";

import { proxyContext } from "@opendum/api/context";
import { runOrpc } from "@opendum/api/web/orpc/run";
import { publishModels, subscribeEvents } from "@opendum/api/web/events/bus";
import "@opendum/api/web/events/snapshots";
import { originOf } from "@opendum/api/web/lib/request-origin";
import * as accountAuth from "@opendum/api/web/services/account-auth";
import * as accountQuota from "@opendum/api/web/services/account-quota";
import * as accounts from "@opendum/api/web/services/accounts";
import * as analytics from "@opendum/api/web/services/analytics";
import * as apiKeys from "@opendum/api/web/services/api-keys";
import * as customProviders from "@opendum/api/web/services/custom-providers";
import * as maintainer from "@opendum/api/web/services/maintainer";
import * as models from "@opendum/api/web/services/models";
import * as ops from "@opendum/api/web/services/ops";
import { getPlaygroundOptions } from "@opendum/api/web/services/playground";
import { claimDaily, pointStatus } from "@opendum/api/web/services/points";
import { sharingEnabled, setSharing } from "@opendum/api/web/services/sharing";
import { requireMaintainer, requireWritable, resolveContext, type OrpcInitialContext } from "@opendum/api/web/orpc/context";

const base = implement(contract).$context<OrpcInitialContext>();

const authed = base.use(async ({ context, next }) => {
  const requestContext = await Effect.runPromise(resolveContext(context.headers));
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

function endpointPath(endpoint: "chat_completions" | "messages" | "responses"): string {
  if (endpoint === "messages") return "/v1/messages";
  if (endpoint === "responses") return "/v1/responses";
  return "/v1/chat/completions";
}

export const router = authed.router({
  models: {
    list: authed.models.list.handler(({ context, input }) =>
      runOrpc(models.listModels(context.requestContext.userId, input ?? {}))
    ),
    search: authed.models.search.handler(({ context }) =>
      runOrpc(models.searchModels(context.requestContext.userId))
    ),
    catalog: authed.models.catalog.handler(() => models.knownModels()),
    families: authed.models.families.handler(() => models.familyCounts()),
    stats: authed.models.stats.handler(({ context, input }) =>
      runOrpc(models.getModelStats(context.requestContext.userId, input))
    ),
    enable: writable.models.enable.handler(({ context, input }) =>
      runOrpc(
        models.enableModel(context.requestContext.userId, input).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              if (result.success) publishModels(context.requestContext.userId);
            })
          )
        )
      )
    ),
  },
  events: {
    subscribe: authed.events.subscribe.handler(({ context, input, signal }) =>
      subscribeEvents(context.requestContext.userId, input.topics, signal)
    ),
  },
  admin: {
    quota: maintainerOnly.admin.quota.handler(({ input }) =>
      Effect.runPromise(
        Effect.flatMap(
          Effect.tryPromise({
            try: () => proxyContext(),
            catch: (cause) => new ORPCError("INTERNAL_SERVER_ERROR", { message: String(cause) }),
          }),
          (context) => ops.opsQuota(context, input)
        )
      )
    ),
    relay: maintainerOnly.admin.relay.handler(({ input }) =>
      Effect.runPromise(
        Effect.flatMap(
          Effect.tryPromise({
            try: () => proxyContext(),
            catch: (cause) => new ORPCError("INTERNAL_SERVER_ERROR", { message: String(cause) }),
          }),
          (context) => ops.runOpsRelay(context, input)
        )
      )
    ),
    users: maintainerOnly.admin.users.handler(({ context, input }) =>
      runOrpc(maintainer.searchAuditUsers(context.requestContext.actor.id, input))
    ),
  },
  accounts: {
    list: authed.accounts.list.handler(({ context }) =>
      runOrpc(accounts.listAccounts(context.requestContext.userId))
    ),
    overview: authed.accounts.overview.handler(({ context }) =>
      runOrpc(
        accounts.getAccountOverview(context.requestContext.userId, {
          autoPin: !context.requestContext.isAuditMode,
        })
      )
    ),
    ping: authed.accounts.ping.handler(({ context }) =>
      runOrpc(
        accounts.getAccountPing(context.requestContext.userId, {
          autoPin: !context.requestContext.isAuditMode,
        })
      )
    ),
    provider: authed.accounts.provider.handler(({ context, input }) =>
      runOrpc(accounts.listByProvider(context.requestContext.userId, input))
    ),
    detail: authed.accounts.detail.handler(({ context, input }) =>
      runOrpc(accounts.accountsDetailed(context.requestContext.userId, input))
    ),
    stats: authed.accounts.stats.handler(({ context, input }) =>
      runOrpc(accounts.getAccountStats(context.requestContext.userId, { accountIds: input.accountIds }))
    ),
    create: writable.accounts.create.handler(({ context, input }) =>
      runOrpc(accounts.createAccount(context.requestContext.userId, input))
    ),
    update: writable.accounts.update.handler(({ context, input }) =>
      runOrpc(accounts.updateAccount(context.requestContext.userId, input))
    ),
    delete: writable.accounts.delete.handler(({ context, input }) =>
      runOrpc(accounts.deleteAccount(context.requestContext.userId, input))
    ),
    pin: writable.accounts.pin.handler(({ context, input }) =>
      runOrpc(accounts.togglePinnedProvider(context.requestContext.userId, input))
    ),
    enable: writable.accounts.enable.handler(({ context, input }) =>
      runOrpc(accounts.enableModel(context.requestContext.userId, input))
    ),
    error: authed.accounts.error.handler(({ context, input }) =>
      runOrpc(accounts.errorHistory(context.requestContext.userId, input))
    ),
    errors: authed.accounts.errors.handler(({ context, input }) =>
      runOrpc(accounts.errorHistories(context.requestContext.userId, input))
    ),
    resolve: authed.accounts.resolve.handler(({ context, input }) =>
      runOrpc(accounts.resolveAccountErrors(context.requestContext.userId, input))
    ),
    session: writable.accounts.session.handler(({ context, input }) => {
      if (process.env.NODE_ENV === "production" && !context.requestContext.isMaintainer) {
        raise(new ORPCError("NOT_FOUND", { message: "Not Found" }));
      }
      return runOrpc(accounts.getAccountSession(context.requestContext.userId, input));
    }),
    auth: writable.accounts.auth.handler(({ input }) => runOrpc(accountAuth.authUrlFor(input))),
    exchange: writable.accounts.exchange.handler(({ context, input }) =>
      runOrpc(accountAuth.exchangeAccount(context.requestContext.userId, input))
    ),
    initiate: writable.accounts.initiate.handler(({ input }) =>
      runOrpc(accountAuth.initiateDeviceAuth(input))
    ),
    poll: writable.accounts.poll.handler(({ context, input }) =>
      runOrpc(accountAuth.pollAuth(context.requestContext.userId, input))
    ),
    codex: writable.accounts.codex.handler(({ context, input }) =>
      runOrpc(accountAuth.connectCodex(context.requestContext.userId, input))
    ),
    quota: authed.accounts.quota.handler(({ context, input }) =>
      runOrpc(
        accountQuota.getAccountQuota(context.requestContext.userId, {
          ...input,
          forceRefresh: input.forceRefresh ?? false,
        })
      )
    ),
    quotas: authed.accounts.quotas.handler(({ context, input }) =>
      runOrpc(
        accountQuota.getAccountQuotas(context.requestContext.userId, {
          ...input,
          forceRefresh: input.forceRefresh ?? false,
        })
      )
    ),
  },
  keys: {
    list: authed.keys.list.handler(({ context }) =>
      runOrpc(
        apiKeys.listApiKeys(context.requestContext.userId, {
          expireActiveKeys: !context.requestContext.isAuditMode,
        })
      )
    ),
    options: authed.keys.options.handler(({ context }) =>
      runOrpc(apiKeys.getOptions(context.requestContext.userId))
    ),
    create: writable.keys.create.handler(({ context, input }) =>
      runOrpc(apiKeys.createApiKey(context.requestContext.userId, input))
    ),
    delete: writable.keys.delete.handler(({ context, input }) =>
      runOrpc(apiKeys.deleteApiKey(context.requestContext.userId, input.id))
    ),
    rename: writable.keys.rename.handler(({ context, input }) =>
      runOrpc(apiKeys.updateName(context.requestContext.userId, input))
    ),
    expire: writable.keys.expire.handler(({ context, input }) =>
      runOrpc(apiKeys.updateExpiration(context.requestContext.userId, input))
    ),
    roaming: writable.keys.roaming.handler(({ context, input }) =>
      runOrpc(apiKeys.updateRoaming(context.requestContext.userId, input))
    ),
    models: writable.keys.models.handler(({ context, input }) =>
      runOrpc(apiKeys.updateModels(context.requestContext.userId, input))
    ),
    accounts: writable.keys.accounts.handler(({ context, input }) =>
      runOrpc(apiKeys.updateAccess(context.requestContext.userId, input))
    ),
    limits: writable.keys.limits.handler(({ context, input }) =>
      runOrpc(apiKeys.updateRateLimits(context.requestContext.userId, input))
    ),
    reveal: writable.keys.reveal.handler(({ context, input }) =>
      runOrpc(apiKeys.revealApiKey(context.requestContext.userId, input.id))
    ),
    toggle: writable.keys.toggle.handler(({ context, input }) =>
      runOrpc(apiKeys.toggleApiKey(context.requestContext.userId, input.id))
    ),
  },
  providers: {
    list: authed.providers.list.handler(({ context }) =>
      runOrpc(customProviders.listCustomProviders(context.requestContext.userId))
    ),
    create: writable.providers.create.handler(({ context, input }) =>
      runOrpc(customProviders.createCustomProvider(context.requestContext.userId, input))
    ),
    update: writable.providers.update.handler(({ context, input }) =>
      runOrpc(customProviders.updateCustomProvider(context.requestContext.userId, input))
    ),
    delete: writable.providers.delete.handler(({ context, input }) =>
      runOrpc(customProviders.deleteCustomProvider(context.requestContext.userId, input.slug))
    ),
    connect: writable.providers.connect.handler(({ context, input }) =>
      runOrpc(
        customProviders.connectCustom(
          context.requestContext.userId,
          input.slug,
          input.token,
          input.name
        )
      )
    ),
    sync: writable.providers.sync.handler(({ context, input }) =>
      runOrpc(customProviders.syncCustomModels(context.requestContext.userId, input.slug, input.token))
    ),
    preview: writable.providers.preview.handler(({ input }) =>
      runOrpc(customProviders.previewCustomModels(input))
    ),
    models: writable.providers.models.handler(({ context, input }) =>
      runOrpc(customProviders.upsertCustomModels(context.requestContext.userId, input.slug, input.models))
    ),
    model: writable.providers.model.handler(({ context, input }) =>
      runOrpc(customProviders.deleteCustomModel(context.requestContext.userId, input.slug, input.modelId))
    ),
  },
  analytics: {
    data: authed.analytics.data.handler(({ context, input }) =>
      runOrpc(analytics.getAnalyticsData(context.requestContext.userId, input))
    ),
    series: authed.analytics.series.handler(({ context, input }) =>
      runOrpc(analytics.getAnalyticsSeries(context.requestContext.userId, input))
    ),
    overview: authed.analytics.overview.handler(({ context }) =>
      runOrpc(analytics.getAnalyticsOverview(context.requestContext.userId))
    ),
    usage: authed.analytics.usage.handler(({ context, input }) =>
      runOrpc(analytics.getUsageRows(context.requestContext.userId, input))
    ),
  },
  session: {
    get: authed.session.get.handler(({ context }) =>
      runOrpc(
        Effect.gen(function* () {
          const requestContext = context.requestContext;
          const [points, sharing] = yield* Effect.all(
            [
              pointStatus(requestContext.userId),
              sharingEnabled(requestContext.userId),
            ],
            { concurrency: "unbounded" }
          );

          return {
            role: requestContext.role,
            isMaintainer: requestContext.isMaintainer,
            points: {
              balance: points.balance,
              roamingByKey: points.roamingByKey,
            },
            sharing: { enabled: sharing },
            actor: requestContext.actor,
            audit: {
              active: requestContext.isAuditMode,
              readonly: requestContext.isAuditMode,
              user: requestContext.auditUser,
            },
          };
        })
      )
    ),
  },
  points: {
    get: authed.points.get.handler(({ context }) =>
      runOrpc(
        Effect.gen(function* () {
          const requestContext = context.requestContext;
          yield* claimDaily(requestContext.actor.id).pipe(Effect.ignore);
          return yield* pointStatus(requestContext.userId);
        })
      )
    ),
  },
  sharing: {
    get: authed.sharing.get.handler(({ context }) =>
      runOrpc(sharingEnabled(context.requestContext.userId))
    ),
    update: writable.sharing.update.handler(({ context, input }) =>
      runOrpc(setSharing(context.requestContext.userId, input.enabled))
    ),
  },
  playground: {
    options: authed.playground.options.handler(({ context }) =>
      runOrpc(
        getPlaygroundOptions(
          context.requestContext.userId,
          originOf(context.headers, context.url)
        )
      )
    ),
    auth: authed.playground.auth.handler(({ context, input }) => {
      const requestContext = context.requestContext;
      const timestamp = String(Math.floor(Date.now() / 1000));
      const method = "POST";
      const path = endpointPath(input.endpoint);
      const secret = process.env.BETTER_AUTH_SECRET;
      if (!secret) raise(new ORPCError("INTERNAL_SERVER_ERROR", { message: "BETTER_AUTH_SECRET is required" }));

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
