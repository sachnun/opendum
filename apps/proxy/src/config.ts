import "dotenv/config";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  betterAuthSecret: string;
  modelsDir: string;
  tokenRefreshIntervalSeconds: number;
}

function getenv(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

function durationSeconds(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  const seconds = Number.parseInt(value, 10);
  if (Number.isNaN(seconds) || seconds < 0) return fallback;
  return seconds;
}

export function resolveModelsDir(configured?: string): string {
  if (configured) return configured;

  const candidates = [
    resolve(process.cwd(), "models"),
    resolve(process.cwd(), "../../models"),
    resolve(process.cwd(), "../../../models"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../models"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../models"),
  ];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && readdirSync(candidate).length >= 0) return candidate;
    } catch {
      // continue
    }
  }

  throw new Error("MODELS_DIR is required when models cannot be auto-detected");
}

export function loadConfig(): Config {
  const port = Number.parseInt(getenv("PORT", "4001"), 10);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error("invalid PORT");
  }

  const databaseUrl = process.env.DATABASE_URL ?? "";
  const redisUrl = process.env.REDIS_URL ?? "";
  const betterAuthSecret = process.env.BETTER_AUTH_SECRET ?? "";

  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!redisUrl) throw new Error("REDIS_URL is required");
  if (!betterAuthSecret) throw new Error("BETTER_AUTH_SECRET is required");

  return {
    host: getenv("HOST", "0.0.0.0"),
    port,
    databaseUrl,
    redisUrl,
    betterAuthSecret,
    modelsDir: resolveModelsDir(process.env.MODELS_DIR),
    tokenRefreshIntervalSeconds: durationSeconds("TOKEN_REFRESH_INTERVAL_SECONDS", 10 * 60),
  };
}
