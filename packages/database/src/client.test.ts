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

test("db proxy resolves the shared pool lazily and caches it", () => {
  const first = client.db.$client;
  const second = client.db.$client;

  assert.equal(typeof client.db.select, "function");
  assert.equal(first, second);
  assert.equal(first.options.max, 3);
});
