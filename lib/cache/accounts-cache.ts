import { getAnalyticsCacheVersion } from "@/lib/cache/analytics-cache";
import { getRedisClient } from "@/lib/redis";
import { getRedisJson, setRedisJson } from "@/lib/redis-cache";

const ACCOUNTS_CACHE_PREFIX = "opendum:accounts:v1";
const ACCOUNTS_CACHE_TTL_SECONDS = 60;

function buildAccountsCacheKey(userId: string, version: number): string {
  return `${ACCOUNTS_CACHE_PREFIX}:${userId}:v${version}`;
}

async function getVersionedAccountsCacheKey(userId: string): Promise<string> {
  await getRedisClient();
  const version = await getAnalyticsCacheVersion(userId);
  return buildAccountsCacheKey(userId, version);
}

export async function getCachedAccountStats<T>(userId: string): Promise<T | null> {
  const cacheKey = await getVersionedAccountsCacheKey(userId);
  return getRedisJson<T>(cacheKey);
}

export async function setCachedAccountStats<T>(userId: string, data: T): Promise<void> {
  const cacheKey = await getVersionedAccountsCacheKey(userId);
  await setRedisJson(cacheKey, data, ACCOUNTS_CACHE_TTL_SECONDS);
}
