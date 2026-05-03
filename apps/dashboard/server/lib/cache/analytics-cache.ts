import { getRedisClient } from "../redis.js";

const ANALYTICS_CACHE_PREFIX = "opendum:analytics:v1";
const ANALYTICS_VERSION_PREFIX = `${ANALYTICS_CACHE_PREFIX}:version`;


interface AnalyticsCacheKeyParams {
  userId: string;
  apiKeyId?: string;
  startDateMs: number;
  endDateMs: number;
  granularity: string;
  version: number;
}

const GRANULARITY_MS_BY_KEY: Record<string, number> = {
  "10s": 10 * 1000,
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

function getVersionKey(userId: string): string {
  return `${ANALYTICS_VERSION_PREFIX}:${userId}`;
}

function alignTimestampToGranularityBoundary(timestampMs: number, granularity: string): number {
  const granularityMs = GRANULARITY_MS_BY_KEY[granularity];
  if (!granularityMs) {
    return timestampMs;
  }

  return Math.floor(timestampMs / granularityMs) * granularityMs;
}

export function buildAnalyticsCacheKey(params: AnalyticsCacheKeyParams): string {
  const apiKeySegment = params.apiKeyId ?? "all";
  const roundedStartDateMs = alignTimestampToGranularityBoundary(
    params.startDateMs,
    params.granularity
  );
  const roundedEndDateMs = alignTimestampToGranularityBoundary(
    params.endDateMs,
    params.granularity
  );

  return `${ANALYTICS_CACHE_PREFIX}:${params.userId}:${apiKeySegment}:${params.granularity}:${roundedStartDateMs}:${roundedEndDateMs}:v${params.version}`;
}

export async function getAnalyticsCacheVersion(userId: string): Promise<number> {
  const redis = await getRedisClient();

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
