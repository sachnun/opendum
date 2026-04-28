import Redis from "ioredis";

const globalKey = "__opendum_redis_client__";

let redisClient: Redis | null = null;

export async function getRedisClient(): Promise<Redis> {
  if (redisClient) {
    return redisClient;
  }

  // Reuse cached client across HMR in dev
  const cached = (globalThis as Record<string, unknown>)[globalKey] as Redis | undefined;
  if (cached) {
    redisClient = cached;
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL ?? null;

  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  redisClient = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  redisClient.on("error", () => undefined);

  (globalThis as Record<string, unknown>)[globalKey] = redisClient;

  return redisClient;
}
