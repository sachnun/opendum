import { getRedisClient } from "./redis.js";

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
  try {
    const redis = await getRedisClient();
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
  try {
    const redis = await getRedisClient();
    await redis.set(key, JSON.stringify(value), { EX: Math.max(1, Math.floor(ttlSeconds)) });
  } catch {
    // Ignore cache write errors
  }
}
