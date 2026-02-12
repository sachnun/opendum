import { getRedisClient } from "@/lib/redis";

function parseJsonValue<T>(rawValue: string | null): T | null {
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as T;
  } catch {
    return null;
  }
}

export async function getRedisJson<T>(key: string): Promise<T | null> {
  const redis = await getRedisClient();
  if (!redis) {
    return null;
  }

  try {
    const rawValue = await redis.get(key);
    return parseJsonValue<T>(rawValue);
  } catch {
    return null;
  }
}

export async function setRedisJson(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) {
    return;
  }

  try {
    await redis.set(key, JSON.stringify(value), {
      EX: Math.max(1, Math.floor(ttlSeconds)),
    });
  } catch {
    // Ignore cache write errors
  }
}

export async function deleteRedisKey(key: string): Promise<void> {
  const redis = await getRedisClient();
  if (!redis) {
    return;
  }

  try {
    await redis.del(key);
  } catch {
    // Ignore cache delete errors
  }
}
