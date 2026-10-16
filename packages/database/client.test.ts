import { afterAll, beforeAll, expect, test } from "bun:test";

import * as relations from "./relations.js";
import * as schema from "./schema/index.js";

const UNREACHABLE_URL = "postgres://opendum:opendum@127.0.0.1:1/opendum?sslmode=require";

let originalDatabaseUrl: string | undefined;
let client: typeof import("./client.js");

beforeAll(async () => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = UNREACHABLE_URL;
  client = await import("./client.js");
});

afterAll(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }

  process.env.DATABASE_URL = originalDatabaseUrl;
});

test("fullSchema exposes every schema and relations export", () => {
  expect(Object.keys(client.fullSchema).sort()).toEqual([...Object.keys(schema), ...Object.keys(relations)].sort());
});

test("db proxy resolves the shared client lazily and caches it", () => {
  const first = client.db.$client;
  const second = client.db.$client;

  expect(typeof client.db.select).toBe("function");
  expect(first).toBe(second);
  expect(first.options.max).toBe(10);
});

test("only the pool size is overridden, timeouts keep their defaults", () => {
  const options = client.db.$client.options;

  expect(options.max).toBe(10);
  expect(options.idleTimeout).toBeUndefined();
  expect(options.connectionTimeout).toBeUndefined();
  expect(options.maxLifetime).toBeUndefined();
});

test("named prepared statements are disabled to avoid stale relation OIDs", () => {
  expect(client.db.$client.options.prepare).toBe(false);
});
