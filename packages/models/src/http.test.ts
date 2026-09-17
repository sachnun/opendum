import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_FETCH_ATTEMPTS, fetchJson, fetchText, sleep } from "./http.ts";

type Stub = (url: string, init?: RequestInit) => Promise<Response>;

function withFetch<T>(stub: Stub, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("sleep resolves after the requested delay", async () => {
  const start = Date.now();
  await sleep(10);
  assert.ok(Date.now() - start >= 5);
});

test("fetchJson returns the parsed JSON body", async () => {
  const payload = await withFetch(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () => fetchJson("https://example.test/data"),
  );
  assert.deepEqual(payload, { ok: true });
});

test("fetchText returns the raw text body", async () => {
  const payload = await withFetch(
    async () => new Response("hello", { status: 200 }),
    () => fetchText("https://example.test/data"),
  );
  assert.equal(payload, "hello");
});

test("fetchJson retries after a transient failure", async () => {
  let calls = 0;
  const payload = await withFetch(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return new Response(JSON.stringify({ retried: true }), { status: 200 });
    },
    () => fetchJson("https://example.test/data", { attempts: 2 }),
  );
  assert.equal(calls, 2);
  assert.deepEqual(payload, { retried: true });
});

test("fetchJson rejects after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    withFetch(
      async () => {
        calls += 1;
        throw new Error("still down");
      },
      () => fetchJson("https://example.test/data", { attempts: 1 }),
    ),
    /still down/,
  );
  assert.equal(calls, 1);
});

test("fetchJson rejects on non-ok responses without retrying by default label", async () => {
  await assert.rejects(
    withFetch(
      async () => new Response("boom", { status: 500, statusText: "Server Error" }),
      () => fetchJson("https://example.test/data", { attempts: 1, label: "example" }),
    ),
    /Failed to fetch example \(500 Server Error\)/,
  );
});

test("MAX_FETCH_ATTEMPTS is a sane default", () => {
  assert.ok(MAX_FETCH_ATTEMPTS >= 2);
});
