import { afterEach, describe, expect, it, mock } from "bun:test";
import { Effect } from "effect";

const originalEnv = { ...process.env };

function restoreEnv(): void {
  for (const key of ["NUXT_PUBLIC_PROXY_URL", "BETTER_AUTH_SECRET"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}

afterEach(() => {
  restoreEnv();
  mock.restore();
});

describe("internal relay", () => {
  it("fails with a typed not-configured error when the proxy url is missing", async () => {
    delete process.env.NUXT_PUBLIC_PROXY_URL;
    const { relayRequest } = await import("../../server/lib/proxy/internal-relay.js");
    const exit = await Effect.runPromiseExit(relayRequest("/internal/quota", {}));
    expect(exit._tag).toBe("Failure");
  });

  it("posts a signed request and returns the upstream response", async () => {
    process.env.NUXT_PUBLIC_PROXY_URL = "https://proxy.example.com";
    process.env.BETTER_AUTH_SECRET = "secret";
    const calls: Array<{ url: string; headers: HeadersInit | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: init?.headers });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const { relayRequest } = await import("../../server/lib/proxy/internal-relay.js");
    const response = await Effect.runPromise(relayRequest("/internal/quota", { userId: "u" }));
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe("https://proxy.example.com/internal/quota");
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("x-opendum-internal-signature")).toBeTruthy();
  });

  it("retries transient network failures with a bounded schedule", async () => {
    process.env.NUXT_PUBLIC_PROXY_URL = "https://proxy.example.com";
    process.env.BETTER_AUTH_SECRET = "secret";
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts < 2) throw new Error("network down");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { relayRequest } = await import("../../server/lib/proxy/internal-relay.js");
    const response = await Effect.runPromise(relayRequest("/internal/refresh", {}));
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
  });
});
