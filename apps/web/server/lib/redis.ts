import type { RedisClientType } from "redis";

const globalKey = "__opendum_redis_client__";

let redisClient: RedisClientType | null = null;
let redisConnectPromise: Promise<RedisClientType> | null = null;

async function ensureConnected(client: RedisClientType): Promise<RedisClientType> {
  if (client.isOpen) {
    return client;
  }

  redisConnectPromise ??= client.connect()
    .then(() => client)
    .finally(() => {
      redisConnectPromise = null;
    });

  return redisConnectPromise;
}

export async function getRedisClient(): Promise<RedisClientType> {
  if (redisClient) {
    return ensureConnected(redisClient);
  }

  // Reuse cached client across HMR in dev
  const cached = (globalThis as Record<string, unknown>)[globalKey] as RedisClientType | undefined;
  if (cached) {
    redisClient = cached;
    return ensureConnected(redisClient);
  }

  const redisUrl = process.env.REDIS_URL ?? null;

  if (!redisUrl) {
    throw new Error("REDIS_URL is required");
  }

  const { createClient } = await import("redis");
  redisClient = createClient({ url: redisUrl }) as RedisClientType;
  redisClient.on("error", () => undefined);

  (globalThis as Record<string, unknown>)[globalKey] = redisClient;

  return ensureConnected(redisClient);
}
