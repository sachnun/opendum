import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, envSchema, loadEnv, loadEnvFile } from "#config/index.ts";

describe("envSchema", () => {
  it("accepts a fully specified environment", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgres://localhost/db",
      REDIS_URL: "redis://localhost",
      BETTER_AUTH_SECRET: "secret",
      NODE_ENV: "production",
    });
    assert.equal(parsed.NODE_ENV, "production");
  });

  it("defaults NODE_ENV to development", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgres://localhost/db",
      REDIS_URL: "redis://localhost",
      BETTER_AUTH_SECRET: "secret",
    });
    assert.equal(parsed.NODE_ENV, "development");
  });
});

describe("loadEnv", () => {
  it("returns the parsed environment", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://localhost/db",
      REDIS_URL: "redis://localhost",
      BETTER_AUTH_SECRET: "secret",
      NODE_ENV: "test",
    });
    assert.equal(env.DATABASE_URL, "postgres://localhost/db");
    assert.equal(env.NODE_ENV, "test");
  });

  it("throws ConfigError listing missing fields", () => {
    assert.throws(
      () => loadEnv({}),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /DATABASE_URL/);
        return true;
      }
    );
  });

  it("rejects an unknown NODE_ENV", () => {
    assert.throws(
      () =>
        loadEnv({
          DATABASE_URL: "db",
          REDIS_URL: "redis",
          BETTER_AUTH_SECRET: "secret",
          NODE_ENV: "staging",
        }),
      ConfigError
    );
  });
});

describe("loadEnvFile", () => {
  it("loads a valid env file and ignores a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "opendum-config-"));
    const path = join(dir, ".env");
    writeFileSync(path, 'SOME_UNIQUE_TEST_KEY="loaded"\n');
    loadEnvFile(path);
    assert.equal(process.env.SOME_UNIQUE_TEST_KEY, "loaded");
    delete process.env.SOME_UNIQUE_TEST_KEY;
    assert.doesNotThrow(() => loadEnvFile(join(dir, "does-not-exist.env")));
  });
});
