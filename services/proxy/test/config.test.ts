import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Env } from "@opendum/config";
import { toProxyConfig } from "../src/config.ts";

function env(overrides: Record<string, unknown> = {}): Env {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgres://db",
    REDIS_URL: "redis://cache",
    BETTER_AUTH_SECRET: "secret",
    ...overrides,
  } as unknown as Env;
}

describe("toProxyConfig", () => {
  it("uses local defaults outside production", () => {
    const config = toProxyConfig(env());
    assert.deepEqual(config, {
      host: "127.0.0.1",
      port: 4001,
      databaseUrl: "postgres://db",
      redisUrl: "redis://cache",
      betterAuthSecret: "secret",
      requestTimeoutMs: 90_000,
      tokenRefreshIntervalMs: 0,
    });
  });

  it("uses production defaults", () => {
    const config = toProxyConfig(env({ NODE_ENV: "production" }));
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 8000);
    assert.equal(config.tokenRefreshIntervalMs, 600_000);
  });
});
