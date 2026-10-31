import { Config, Effect } from "effect";

export function envFile(path = ".env"): void {
  const loaded = Effect.runSyncExit(Effect.try(() => process.loadEnvFile(path)));
  void loaded;
}

export const effectEnv = Config.all({
  databaseUrl: Config.NonEmptyString("DATABASE_URL"),
  redisUrl: Config.NonEmptyString("REDIS_URL"),
  betterAuthSecret: Config.NonEmptyString("BETTER_AUTH_SECRET"),
  nodeEnv: Config.Literals(["development", "test", "production"], "NODE_ENV").pipe(
    Config.withDefault("development")
  ),
});
