import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import * as relations from "./relations.js";
import * as schema from "./schema/index.js";

const UNREACHABLE_URL = "postgres://opendum:opendum@127.0.0.1:1/opendum";

let originalDatabaseUrl: string | undefined;
let client: typeof import("./client.js");

before(async () => {
  originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = UNREACHABLE_URL;
  client = await import("./client.js");
});

after(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }

  process.env.DATABASE_URL = originalDatabaseUrl;
});

test("fullSchema exposes every schema and relations export", () => {
  assert.deepEqual(
    Object.keys(client.fullSchema).sort(),
    [...Object.keys(schema), ...Object.keys(relations)].sort(),
  );
});

test("createRequestDb returns a drizzle client with its own pool", async () => {
  const request = await client.createRequestDb();

  try {
    assert.equal(typeof request.db.select, "function");
    assert.equal(typeof request.db.$client.end, "function");
  } finally {
    await request.close();
  }
});

test("createRequestDb hands out an independent pool per call", async () => {
  const first = await client.createRequestDb();
  const second = await client.createRequestDb();

  try {
    assert.notEqual(first.db.$client, second.db.$client);
  } finally {
    await first.close();
    await second.close();
  }
});

test("close ends the pool, stays idempotent and warns instead of throwing", async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const request = await client.createRequestDb();

    await request.close();
    await request.close();

    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /Failed to close Postgres client/);
  } finally {
    console.warn = originalWarn;
  }
});

test("db proxy resolves the shared pool lazily and caches it", () => {
  const first = client.db.$client;
  const second = client.db.$client;

  assert.equal(typeof client.db.select, "function");
  assert.equal(first, second);
});
