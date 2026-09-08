import { createClient, type RedisClientType } from "redis";
import { config } from "./config.js";

let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    if (!config.redisUrl) {
      throw new Error("REDIS_URL is required");
    }
    redisClient = createClient({ url: config.redisUrl });
    redisClient.on("error", (err) => console.error("Redis client error:", err));
    await redisClient.connect();
  }
  return redisClient;
}
