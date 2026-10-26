import { expect, test } from "bun:test";

import { MAX_FETCH_ATTEMPTS, runJson, runText, sleep } from "./http.ts";

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

test("runJson returns the parsed JSON body", async () => {
  const payload = await withFetch(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    () => runJson("https://example.test/data"),
  );
  expect(payload).toEqual({ ok: true });
});

test("runText returns the raw text body", async () => {
  const payload = await withFetch(
    async () => new Response("hello", { status: 200 }),
    () => runText("https://example.test/data"),
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
    () => runJson("https://example.test/data", { attempts: 2 }),
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
      () => runJson("https://example.test/data", { attempts: 1 }),
    ),
  ).rejects.toThrow(/still down/);
  expect(calls).toBe(1);
});

test("fetchJson rejects on non-ok responses without retrying by default label", async () => {
  await expect(
    withFetch(
      async () => new Response("boom", { status: 500, statusText: "Server Error" }),
      () => runJson("https://example.test/data", { attempts: 1, label: "example" }),
    ),
  ).rejects.toThrow(/Failed to fetch example \(500 Server Error\)/);
});

test("fetchJson retries rate limited responses and reports the status", async () => {
  let calls = 0;
  const payload = await withFetch(
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("slow down", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ retried: true }), { status: 200 });
    },
    () => runJson("https://example.test/data", { attempts: 2 }),
  );
  expect(calls).toBe(2);
  expect(payload).toEqual({ retried: true });
});

test("fetchJson exposes the status on exhausted rate limits", async () => {
  await expect(
    withFetch(
      async () =>
        new Response("slow down", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "0" },
        }),
      () => runJson("https://example.test/data", { attempts: 1, label: "example" }),
    ),
  ).rejects.toThrow(/Failed to fetch example \(429 Too Many Requests\)/);
});

test("fetchText retries a body read timeout instead of failing on the status", async () => {
  let calls = 0;
  const payload = await withFetch(
    async () => {
      calls += 1;
      if (calls === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html>"));
            setTimeout(() => controller.error(new DOMException("The operation timed out.", "TimeoutError")), 50);
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response("complete", { status: 200 });
    },
    () => runText("https://example.test/page", { attempts: 2, timeout: 5_000 }),
  );
  expect(calls).toBe(2);
  expect(payload).toBe("complete");
});

test("MAX_FETCH_ATTEMPTS is a sane default", () => {
  expect(MAX_FETCH_ATTEMPTS >= 2).toBeTruthy();
});
