import { createClient } from "redis";

type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;
let redisClientPromise: Promise<RedisClient | null> | null = null;

function resolveRedisUrl(): string | null {
  return process.env.REDIS_URL ?? null;
}

export async function getRedisClient(): Promise<RedisClient | null> {
  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (redisClientPromise) {
    return redisClientPromise;
  }

  const redisUrl = resolveRedisUrl();
  if (!redisUrl) {
    return null;
  }

  if (!redisClient) {
    try {
      redisClient = createClient({ url: redisUrl });
      redisClient.on("error", () => undefined);
    } catch {
      redisClient = null;
      return null;
    }
  }

  redisClientPromise = (async () => {
    if (!redisClient) {
      return null;
    }

    try {
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }

      return redisClient;
    } catch {
      redisClient = null;
      return null;
    }
  })().finally(() => {
    redisClientPromise = null;
  });

  return redisClientPromise;
}

export function isRedisConfigured(): boolean {
  return Boolean(resolveRedisUrl());
}
