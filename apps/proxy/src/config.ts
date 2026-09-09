import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

dotenv.config();
if (existsSync("apps/proxy/.env")) {
  dotenv.config({ path: "apps/proxy/.env" });
}

function resolveModelsDir(): string {
  if (process.env.MODELS_DIR) {
    return resolve(process.env.MODELS_DIR);
  }

  const candidates = [
    resolve(process.cwd(), "packages/models/data"),
    resolve(process.cwd(), "../../packages/models/data"),
    resolve(process.cwd(), "models"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return resolve(process.cwd(), "packages/models/data");
}

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: parseInt(process.env.PORT || "8000", 10),
  databaseUrl: process.env.DATABASE_URL || "",
  redisUrl: process.env.REDIS_URL || "",
  betterAuthSecret: process.env.BETTER_AUTH_SECRET || "",
  modelsDir: resolveModelsDir(),
  tokenRefreshIntervalSeconds: parseInt(
    process.env.TOKEN_REFRESH_INTERVAL_SECONDS || "600",
    10
  ),
};
