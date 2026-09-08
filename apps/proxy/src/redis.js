import { createClient } from "redis";
import { config } from "./config.js";
let redisClient = null;
export async function getRedisClient() {
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
//# sourceMappingURL=redis.js.map