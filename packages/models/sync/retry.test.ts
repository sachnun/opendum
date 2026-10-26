import { describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { raise } from "@opendum/models/refresh/core/raise";

import { fetchDecoded, fetchJson, retryTransient, orThrow } from "@opendum/models/sync/http";
import { ModelFetchFailure } from "@opendum/models/errors";

type Stub = (url: string, init?: RequestInit) => Promise<Response>;

function withFetch<T>(stub: Stub, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

describe("retrying fetch helpers", () => {
  it("retries a transient failure with the shared schedule", async () => {
    let calls = 0;
    const payload = await withFetch(
      async () => {
        calls += 1;
        if (calls < 3) raise(new Error("network down"));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      () => orThrow(fetchJson("https://example.test/data", { attempts: 3 })),
    );
    expect(calls).toBe(3);
    expect(payload).toEqual({ ok: true });
  });

  it("fails with a typed ModelFetchFailure after exhausting attempts", async () => {
    const exit = await withFetch(
      async () => {
        raise(new Error("still down"));
      },
      () => Effect.runPromiseExit(fetchJson("https://example.test/data", { attempts: 1, label: "example" })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Exit.findErrorOption(exit);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ModelFetchFailure);
        expect(failure.value._tag).toBe("ModelFetchFailure");
        expect(failure.value.label).toBe("example");
        expect(failure.value.message).toMatch(/still down/);
      }
    }
  });

  it("fails with a typed failure on a non-ok response", async () => {
    const exit = await withFetch(
      async () => new Response("boom", { status: 500, statusText: "Server Error" }),
      () => Effect.runPromiseExit(fetchJson("https://example.test/data", { attempts: 1, label: "example" })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Exit.findErrorOption(exit);
      if (failure._tag === "Some") {
        expect(failure.value.message).toMatch(/Failed to fetch example \(500 Server Error\)/);
      }
    }
  });

  it("decodes a response through a custom decoder", async () => {
    const value = await withFetch(
      async () => new Response("<p>hello</p>", { status: 200 }),
      () =>
        orThrow(
          fetchDecoded("https://example.test/page", { attempts: 1 }, (response) => response.text()),
        ),
    );
    expect(value).toBe("<p>hello</p>");
  });

  it("retryTransient evaluates the source once when attempts is one", async () => {
    let calls = 0;
    const exit = await Effect.runPromiseExit(
      retryTransient(
        Effect.suspend(() => {
          calls += 1;
          return Effect.fail(new Error("nope"));
        }),
        1,
      ).pipe(Effect.catch(() => Effect.succeed(null))),
    );
    expect(calls).toBe(1);
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});
