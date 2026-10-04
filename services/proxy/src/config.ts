import type { Env } from "@opendum/config";

export type ProxyConfig = {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  betterAuthSecret: string;
  modelsDir: string | undefined;
  unroxyUrl: string;
  psiphonRegion: string;
  requestTimeoutMs: number;
  tokenRefreshIntervalMs: number;
};

export function toProxyConfig(env: Env): ProxyConfig {
  return {
    host: env.HOST,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    modelsDir: env.MODELS_DIR,
    unroxyUrl: env.UNROXY_URL,
    psiphonRegion: env.PSIPHON_REGION,
    requestTimeoutMs: env.REQUEST_TIMEOUT_SECONDS * 1000,
    tokenRefreshIntervalMs: env.TOKEN_REFRESH_INTERVAL_SECONDS * 1000,
  };
}
