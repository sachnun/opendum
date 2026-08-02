import Redis from "ioredis";

export function openRedis(redisUrl: string): Redis {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  return client;
}
