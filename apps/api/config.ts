import { Config } from "effect";

export type ProxyConfig = {
  databaseUrl: string;
  redisUrl: string;
  betterAuthSecret: string;
  requestTimeoutMs: number;
  tokenRefreshIntervalMs: number;
};

const TOKEN_REFRESH_INTERVAL_MS = 600 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;

const nodeEnv = Config.Literals(["development", "test", "production"], "NODE_ENV").pipe(
  Config.withDefault("development")
);

export const proxyConfig: Config.Config<ProxyConfig> = Config.all({
  databaseUrl: Config.NonEmptyString("DATABASE_URL"),
  redisUrl: Config.NonEmptyString("REDIS_URL"),
  betterAuthSecret: Config.NonEmptyString("BETTER_AUTH_SECRET"),
  nodeEnv,
}).pipe(
  Config.map(
    ({ nodeEnv, ...rest }): ProxyConfig => ({
      ...rest,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      tokenRefreshIntervalMs: nodeEnv === "production" ? TOKEN_REFRESH_INTERVAL_MS : 0,
    })
  )
);
