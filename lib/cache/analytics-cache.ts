import { getRedisClient } from "@/lib/redis";

const ANALYTICS_CACHE_PREFIX = "opendum:analytics:v1";
const ANALYTICS_VERSION_PREFIX = `${ANALYTICS_CACHE_PREFIX}:version`;
const ANALYTICS_VERSION_BUMP_PREFIX = `${ANALYTICS_CACHE_PREFIX}:version-bump`;

const ANALYTICS_VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const ANALYTICS_VERSION_BUMP_THROTTLE_SECONDS = 15;

interface AnalyticsCacheKeyParams {
  userId: string;
  apiKeyId?: string;
  startDateMs: number;
  endDateMs: number;
  granularity: string;
  version: number;
}

function getVersionKey(userId: string): string {
  return `${ANALYTICS_VERSION_PREFIX}:${userId}`;
}

function getVersionBumpKey(userId: string): string {
  return `${ANALYTICS_VERSION_BUMP_PREFIX}:${userId}`;
}

export function buildAnalyticsCacheKey(params: AnalyticsCacheKeyParams): string {
  const apiKeySegment = params.apiKeyId ?? "all";
  return `${ANALYTICS_CACHE_PREFIX}:${params.userId}:${apiKeySegment}:${params.granularity}:${params.startDateMs}:${params.endDateMs}:v${params.version}`;
}

export async function getAnalyticsCacheVersion(userId: string): Promise<number> {
  const redis = await getRedisClient();
  if (!redis) {
    return 0;
  }

  try {
    const rawVersion = await redis.get(getVersionKey(userId));
    if (!rawVersion) {
      return 0;
    }

    const parsedVersion = Number.parseInt(rawVersion, 10);
    return Number.isFinite(parsedVersion) && parsedVersion >= 0 ? parsedVersion : 0;
  } catch {
    return 0;
  }
}

export async function bumpAnalyticsCacheVersionThrottled(userId: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) {
    return;
  }

  try {
    const shouldBump = await redis.set(getVersionBumpKey(userId), "1", {
      NX: true,
      EX: ANALYTICS_VERSION_BUMP_THROTTLE_SECONDS,
    });

    if (shouldBump !== "OK") {
      return;
    }

    const nextVersion = await redis.incr(getVersionKey(userId));
    if (nextVersion === 1) {
      await redis.expire(getVersionKey(userId), ANALYTICS_VERSION_TTL_SECONDS);
    }
  } catch {
    // Ignore version bump failures
  }
}
