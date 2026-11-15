import { Effect } from "effect";
import type { AccountsData, LiveTopic, ModelsData, ProviderDetailPayload, UsageData } from "@opendum/providers/contract";

import { statsByModel } from "@opendum/api/web/lib/model-stats";
import { buildAccountStats } from "@opendum/api/web/services/account-stats";
import { accountsDetailed, getAccountOverview, listAccounts } from "@opendum/api/web/services/accounts";
import { familyCounts, listModels } from "@opendum/api/web/services/models";
import { pointStatus } from "@opendum/api/web/services/points";
import { configureSnapshots, type EventSnapshots } from "@opendum/api/web/events/bus";

type BaseData = {
  overview: Effect.Success<ReturnType<typeof getAccountOverview>>;
  accounts: Effect.Success<ReturnType<typeof listAccounts>>;
  models: Effect.Success<ReturnType<typeof listModels>>;
};

const loadBase = Effect.fnUntraced(function* (userId: string) {
  const [overview, accounts, models] = yield* Effect.all(
    [
      getAccountOverview(userId, { autoPin: true }),
      listAccounts(userId),
      listModels(userId, { includeStats: false }),
    ],
    { concurrency: "unbounded" }
  );

  return { overview, accounts, models } satisfies BaseData;
});

const buildAccounts = Effect.fn("snapshots.buildAccounts")(function* (userId: string, base: BaseData) {
  const providers = Array.from(new Set(base.accounts.map((account) => account.provider)));
  const details = yield* Effect.forEach(
    providers,
    (provider) =>
      accountsDetailed(userId, { provider }).pipe(
        Effect.map((detail) => [provider, detail] as const)
      ),
    { concurrency: 4 }
  );

  return {
    overview: base.overview,
    providers: Object.fromEntries(details) as Record<string, ProviderDetailPayload>,
  } satisfies AccountsData;
});

const buildModels = Effect.fn("snapshots.buildModels")(function* (base: BaseData) {
  yield* Effect.void;
  return {
    list: base.models,
    familyCounts: familyCounts(),
  } satisfies ModelsData;
});

const buildUsage = Effect.fn("snapshots.buildUsage")(function* (userId: string, base: BaseData) {
  const accountIds = base.accounts.map((account) => account.id);
  const availableModels = base.models.flatMap((model) => (model.available === false ? [] : [model.id]));
  const [accountStats, modelStats, points] = yield* Effect.all(
    [
      buildAccountStats(userId, accountIds),
      statsByModel(userId, availableModels),
      pointStatus(userId),
    ],
    { concurrency: "unbounded" }
  );

  return {
    overview: base.overview,
    accountStats,
    modelStats: Object.fromEntries(Object.entries(modelStats).filter(([, stats]) => stats.totalRequests > 0)),
    roamingByKey: points.roamingByKey,
  } satisfies UsageData;
});

const buildSnapshots = Effect.fn("snapshots.build")(function* (userId: string, topics: LiveTopic[]) {
  const wanted = new Set(topics);
  if (wanted.size === 0) return {} satisfies Partial<EventSnapshots>;

  const base = yield* loadBase(userId);
  const [accounts, models, usage] = yield* Effect.all(
    [
      wanted.has("accounts") ? buildAccounts(userId, base) : Effect.succeed(undefined),
      wanted.has("models") ? buildModels(base) : Effect.succeed(undefined),
      wanted.has("usage") ? buildUsage(userId, base) : Effect.succeed(undefined),
    ],
    { concurrency: "unbounded" }
  );

  return {
    ...(accounts ? { accounts } : {}),
    ...(models ? { models } : {}),
    ...(usage ? { usage } : {}),
  } satisfies Partial<EventSnapshots>;
});

configureSnapshots(buildSnapshots);
