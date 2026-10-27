import { afterAll, describe, expect, it } from "bun:test";
import { Effect, Exit } from "effect";
import { UnroxyEgress } from "@opendum/core/egress/unroxy";

const encoder = new TextEncoder();

const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/slow-headers") {
      return Bun.sleep(300).then(() => new Response("late"));
    }
    if (path === "/slow-body") {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("a"));
          await Bun.sleep(150);
          controller.enqueue(encoder.encode("b"));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }
    return new Response("ok");
  },
});

const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  void server.stop(true);
});

describe("UnroxyEgress", () => {
  it("aborts when response headers take too long", async () => {
    const egress = new UnroxyEgress({ baseUrl, headersTimeout: 50 });
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({ try: () => egress.fetch("/slow-headers"), catch: (cause) => cause })
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const names = Exit.isFailure(exit) ? exit.cause.reasons.map((reason) => String(reason)) : [];
    expect(names.join(" ")).toContain("upstream headers timed out");
  });

  it("leaves the body untouched after headers arrive", async () => {
    const egress = new UnroxyEgress({ baseUrl, headersTimeout: 50 });
    const response = await egress.fetch("/slow-body");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ab");
  });

  it("passes a fast request through unchanged", async () => {
    const egress = new UnroxyEgress({ baseUrl, headersTimeout: 50 });
    const response = await egress.fetch("/fast");
    expect(await response.text()).toBe("ok");
  });

  it("keeps a caller abort signal working", async () => {
    const egress = new UnroxyEgress({ baseUrl, headersTimeout: 0 });
    const controller = new AbortController();
    const pending = egress.fetch("/slow-headers", { signal: controller.signal });
    controller.abort(new Error("client gone"));
    const exit = await Effect.runPromiseExit(
      Effect.tryPromise({ try: () => pending, catch: (cause) => cause })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
