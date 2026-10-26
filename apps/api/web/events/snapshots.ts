import { Effect } from "effect";
import type { AccountsData, LiveTopic, ModelsData, ProviderDetailPayload, UsageData } from "@opendum/providers/contract";

import { statsByModel } from "#web/lib/model-stats.js";
import { buildAccountStats } from "#web/services/account-stats.js";
import { accountsDetailed, getAccountOverview, listAccounts } from "#web/services/accounts.js";
import { familyCounts, listModels } from "#web/services/models.js";
import { pointStatus } from "#web/services/points.js";
import { configureSnapshots, type EventSnapshots } from "./bus.js";

const buildAccounts = Effect.fn("snapshots.buildAccounts")(function* (userId: string) {
  const overview = yield* getAccountOverview(userId, { autoPin: true });
  const accounts = yield* listAccounts(userId);
  const providers = Array.from(new Set(accounts.map((account) => account.provider)));
  const details = yield* Effect.forEach(
    providers,
    (provider) =>
      accountsDetailed(userId, { provider }).pipe(
        Effect.map((detail) => [provider, detail] as const)
      ),
    { concurrency: 4 }
  );

  return {
    overview,
    providers: Object.fromEntries(details) as Record<string, ProviderDetailPayload>,
  } satisfies AccountsData;
});

const buildModels = Effect.fn("snapshots.buildModels")(function* (userId: string) {
  return {
    list: yield* listModels(userId, { includeStats: false }),
    familyCounts: familyCounts(),
  } satisfies ModelsData;
});

const buildUsage = Effect.fn("snapshots.buildUsage")(function* (userId: string) {
  const [overview, accounts, models] = yield* Effect.all(
    [
      getAccountOverview(userId, { autoPin: true }),
      listAccounts(userId),
      listModels(userId, { includeStats: false }),
    ],
    { concurrency: "unbounded" }
  );
  const accountIds = accounts.map((account) => account.id);
  const availableModels = models.flatMap((model) => (model.available === false ? [] : [model.id]));
  const [accountStats, modelStats, points] = yield* Effect.all(
    [
      buildAccountStats(userId, accountIds),
      statsByModel(userId, availableModels),
      pointStatus(userId),
    ],
    { concurrency: "unbounded" }
  );

  return {
    overview,
    accountStats,
    modelStats: Object.fromEntries(Object.entries(modelStats).filter(([, stats]) => stats.totalRequests > 0)),
    roamingByKey: points.roamingByKey,
  } satisfies UsageData;
});

const buildSnapshots = Effect.fn("snapshots.build")(function* (userId: string, topics: LiveTopic[]) {
  const wanted = new Set(topics);
  const [accounts, models, usage] = yield* Effect.all(
    [
      wanted.has("accounts") ? buildAccounts(userId) : Effect.succeed(undefined),
      wanted.has("models") ? buildModels(userId) : Effect.succeed(undefined),
      wanted.has("usage") ? buildUsage(userId) : Effect.succeed(undefined),
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
