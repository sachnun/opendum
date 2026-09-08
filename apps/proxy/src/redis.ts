import { createClient, type RedisClientType } from "redis";
import { config } from "./config.js";

let redisClient: RedisClientType | null = null;

export async function getRedisClient(): Promise<RedisClientType | null> {
  if (!redisClient) {
    if (!config.redisUrl) {
      return null;
    }
    try {
      const client = createClient({ url: config.redisUrl });
      client.on("error", (err) => console.error("Redis client error:", err));
      await client.connect();
      redisClient = client as RedisClientType;
    } catch (e) {
      console.warn("Could not connect to Redis, running in standalone memory mode:", e);
      return null;
    }
  }
  return redisClient;
}
