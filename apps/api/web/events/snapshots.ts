import type { AccountsData, LiveTopic, ModelsData, ProviderDetailPayload, UsageData } from "@opendum/providers/contract";

import { getModelStatsByModel } from "#web/lib/model-stats.js";
import { buildAccountStats } from "#web/services/account-stats.js";
import { getAccountsByProviderDetailed, getAccountOverview, listAccounts } from "#web/services/accounts.js";
import { getModelFamilyCounts, listModels } from "#web/services/models.js";
import { getUserPointStatus } from "#web/services/points.js";
import { configureEventSnapshots, type EventSnapshots } from "./bus.js";

async function buildAccounts(userId: string): Promise<AccountsData> {
  const overview = await getAccountOverview(userId, { autoPin: true });
  const accounts = await listAccounts(userId);
  const providers = Array.from(new Set(accounts.map((account) => account.provider)));
  const details = await Promise.all(
    providers.map(async (provider) => [provider, await getAccountsByProviderDetailed(userId, { provider })] as const)
  );

  return {
    overview,
    providers: Object.fromEntries(details) as Record<string, ProviderDetailPayload>,
  };
}

async function buildModels(userId: string): Promise<ModelsData> {
  return {
    list: await listModels(userId, { includeStats: false }),
    familyCounts: getModelFamilyCounts(),
  };
}

async function buildUsage(userId: string): Promise<UsageData> {
  const [overview, accounts, models] = await Promise.all([
    getAccountOverview(userId, { autoPin: true }),
    listAccounts(userId),
    listModels(userId, { includeStats: false }),
  ]);
  const accountIds = accounts.map((account) => account.id);
  const availableModels = models.flatMap((model) => (model.available === false ? [] : [model.id]));
  const [accountStats, modelStats, pointStatus] = await Promise.all([
    buildAccountStats(userId, accountIds),
    getModelStatsByModel(userId, availableModels),
    getUserPointStatus(userId),
  ]);

  return {
    overview,
    accountStats,
    modelStats: Object.fromEntries(Object.entries(modelStats).filter(([, stats]) => stats.totalRequests > 0)),
    roamingPointsByApiKeyId: pointStatus.roamingPointsByApiKeyId,
  };
}

async function buildSnapshots(userId: string, topics: LiveTopic[]): Promise<Partial<EventSnapshots>> {
  const wanted = new Set(topics);
  const [accounts, models, usage] = await Promise.all([
    wanted.has("accounts") ? buildAccounts(userId) : undefined,
    wanted.has("models") ? buildModels(userId) : undefined,
    wanted.has("usage") ? buildUsage(userId) : undefined,
  ]);

  return {
    ...(accounts ? { accounts } : {}),
    ...(models ? { models } : {}),
    ...(usage ? { usage } : {}),
  };
}

configureEventSnapshots(buildSnapshots);
