import { expect, test } from "bun:test";

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
  expect(Date.now() - start >= 5).toBeTruthy();
});

test("fetchJson returns the parsed JSON body", async () => {
  const payload = await withFetch(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () => fetchJson("https://example.test/data"),
  );
  expect(payload).toEqual({ ok: true });
});

test("fetchText returns the raw text body", async () => {
  const payload = await withFetch(
    async () => new Response("hello", { status: 200 }),
    () => fetchText("https://example.test/data"),
  );
  expect(payload).toBe("hello");
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
  expect(calls).toBe(2);
  expect(payload).toEqual({ retried: true });
});

test("fetchJson rejects after exhausting attempts", async () => {
  let calls = 0;
  await expect(
    withFetch(
      async () => {
        calls += 1;
        throw new Error("still down");
      },
      () => fetchJson("https://example.test/data", { attempts: 1 }),
    ),
  ).rejects.toThrow(/still down/);
  expect(calls).toBe(1);
});

test("fetchJson rejects on non-ok responses without retrying by default label", async () => {
  await expect(
    withFetch(
      async () => new Response("boom", { status: 500, statusText: "Server Error" }),
      () => fetchJson("https://example.test/data", { attempts: 1, label: "example" }),
    ),
  ).rejects.toThrow(/Failed to fetch example \(500 Server Error\)/);
});

test("MAX_FETCH_ATTEMPTS is a sane default", () => {
  expect(MAX_FETCH_ATTEMPTS >= 2).toBeTruthy();
});
