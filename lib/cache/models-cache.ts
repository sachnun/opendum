import { getAnalyticsCacheVersion } from "@/lib/cache/analytics-cache";
import { getRedisClient } from "@/lib/redis";
import { getRedisJson, setRedisJson } from "@/lib/redis-cache";

const MODELS_CACHE_PREFIX = "opendum:models:v1";
const MODELS_CACHE_TTL_SECONDS = 60;

function buildModelsCacheKey(userId: string, version: number): string {
  return `${MODELS_CACHE_PREFIX}:${userId}:v${version}`;
}

async function getVersionedModelsCacheKey(userId: string): Promise<string> {
  await getRedisClient();
  const version = await getAnalyticsCacheVersion(userId);
  return buildModelsCacheKey(userId, version);
}

export async function getCachedModelStats<T>(userId: string): Promise<T | null> {
  const cacheKey = await getVersionedModelsCacheKey(userId);
  return getRedisJson<T>(cacheKey);
}

export async function setCachedModelStats<T>(userId: string, data: T): Promise<void> {
  const cacheKey = await getVersionedModelsCacheKey(userId);
  await setRedisJson(cacheKey, data, MODELS_CACHE_TTL_SECONDS);
}
