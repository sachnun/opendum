import type { OpendumRedis } from "@opendum/core/redis";
import { getProxyContext } from "../../context.js";

export async function getRedisClient(): Promise<OpendumRedis> {
  return (await getProxyContext()).redis;
}
