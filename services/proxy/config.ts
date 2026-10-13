import type { Env } from "@opendum/core/config";

export type ProxyConfig = {
  databaseUrl: string;
  redisUrl: string;
  betterAuthSecret: string;
  requestTimeoutMs: number;
  tokenRefreshIntervalMs: number;
};

const TOKEN_REFRESH_INTERVAL_MS = 600 * 1000;
const TOKEN_REFRESH_INTERVAL_LOCAL_MS = 0;
const REQUEST_TIMEOUT_MS = 90 * 1000;

export function toProxyConfig(env: Env): ProxyConfig {
  const production = env.NODE_ENV === "production";
  return {
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tokenRefreshIntervalMs: production ? TOKEN_REFRESH_INTERVAL_MS : TOKEN_REFRESH_INTERVAL_LOCAL_MS,
  };
}
