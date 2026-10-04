import type { Env } from "@opendum/config";

export type ProxyConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  betterAuthSecret: string;
  requestTimeoutMs: number;
  tokenRefreshIntervalMs: number;
};

const TOKEN_REFRESH_INTERVAL_MS = 600 * 1000;
const TOKEN_REFRESH_INTERVAL_LOCAL_MS = 0;
const REQUEST_TIMEOUT_MS = 90 * 1000;

const LOCAL_HOST = "127.0.0.1";
const LOCAL_PORT = 4001;
const PRODUCTION_HOST = "0.0.0.0";
const PRODUCTION_PORT = 8000;

export function toProxyConfig(env: Env): ProxyConfig {
  const production = env.NODE_ENV === "production";
  return {
    host: production ? PRODUCTION_HOST : LOCAL_HOST,
    port: production ? PRODUCTION_PORT : LOCAL_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    tokenRefreshIntervalMs: production ? TOKEN_REFRESH_INTERVAL_MS : TOKEN_REFRESH_INTERVAL_LOCAL_MS,
  };
}
