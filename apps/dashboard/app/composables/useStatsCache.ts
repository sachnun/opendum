import { getMany, setMany } from "idb-keyval";
import type { ProviderStats } from "../../lib/api-types";
import { createIdbStore } from "../utils/idb";

type CachedAccountStats = {
  accountId: string;
  stats: ProviderStats;
  cachedAt: number;
};

const ACCOUNT_STATS_DB_NAME = "opendum-dashboard";
const ACCOUNT_STATS_STORE_NAME = "account-stats";
const accountStatsStore = createIdbStore(ACCOUNT_STATS_DB_NAME, ACCOUNT_STATS_STORE_NAME);

function getAccountStatsCacheKey(accountId: string) {
  return `account-stats:${accountId}`;
}

export async function readStatsCache(accountIds: string[]) {
  if (!accountStatsStore || accountIds.length === 0) return [];

  try {
    return await getMany<CachedAccountStats>(accountIds.map(getAccountStatsCacheKey), accountStatsStore);
  } catch (error) {
    console.warn("Failed to read account stats cache:", error);
    return [];
  }
}

export async function writeStatsCache(statsByAccountId: Record<string, ProviderStats>) {
  if (!accountStatsStore) return;

  try {
    const entries: [string, CachedAccountStats][] = Object.entries(statsByAccountId).map(([accountId, stats]) => [
      getAccountStatsCacheKey(accountId),
      { accountId, stats, cachedAt: Date.now() } satisfies CachedAccountStats,
    ]);

    if (entries.length > 0) await setMany(entries, accountStatsStore);
  } catch (error) {
    console.warn("Failed to write account stats cache:", error);
  }
}
