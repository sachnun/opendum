import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { H3, H3Event } from "h3";
import type { ProxyContext } from "../src/context.ts";

const mocks = vi.hoisted(() => ({
  db: { getQuotaAccount: vi.fn() },
  quota: { fetchAccountQuota: vi.fn(), isQuotaProvider: vi.fn() },
  crypto: { decrypt: vi.fn() },
  sig: { validateInternalSignature: vi.fn() },
}));

vi.mock("@opendum/database/queries", () => mocks.db);
vi.mock("@opendum/quota", () => mocks.quota);
vi.mock("@opendum/crypto", () => mocks.crypto);
vi.mock("../src/middleware/internal-signature.ts", () => mocks.sig);

import { registerInternalRoutes } from "../src/routes/internal.ts";

type Handler = (event: H3Event) => Promise<Response> | Response;

function capture(): { app: H3; routes: Map<string, Handler> } {
  const routes = new Map<string, Handler>();
  const app = { post: (path: string, handler: Handler) => routes.set(`POST ${path}`, handler) } as unknown as H3;
  return { app, routes };
}

function event(body: string): H3Event {
  return { req: { headers: new Headers(), text: async () => body } } as unknown as H3Event;
}

function context(overrides: Record<string, unknown> = {}): ProxyContext {
  return {
    config: { betterAuthSecret: "secret" },
    redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
    guardedFetch: vi.fn(async () => new Response("upstream", { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1", "proxy-thing": "1" } })),
    service: { quotaCredentials: vi.fn(async () => "token") },
    ...overrides,
  } as unknown as ProxyContext;
}

function handlers(ctx: ProxyContext): Map<string, Handler> {
  const { app, routes } = capture();
  registerInternalRoutes(app, ctx);
  return routes;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sig.validateInternalSignature.mockResolvedValue(true);
  mocks.quota.isQuotaProvider.mockReturnValue(true);
  mocks.quota.fetchAccountQuota.mockResolvedValue({ groups: [] });
  mocks.crypto.decrypt.mockReturnValue("decrypted");
  mocks.db.getQuotaAccount.mockResolvedValue(null);
});

describe("routes/internal quota", () => {
  const url = "POST /internal/quota";

  it("rejects oversized and malformed payloads", async () => {
    const ctx = context();
    const handler = handlers(ctx).get(url)!;
    assert.equal((await handler(event("x".repeat(70 * 1024)))).status, 400);

    mocks.sig.validateInternalSignature.mockResolvedValueOnce(false);
    assert.equal((await handler(event("{}"))).status, 401);

    assert.equal((await handler(event("not json"))).status, 400);
    assert.equal((await handler(event(JSON.stringify([1, 2])))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ extra: 1 })))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ forceRefresh: "yes" })))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ userId: "u" })))).status, 400);
  });

  it("reports unsupported providers and missing accounts", async () => {
    const ctx = context();
    const handler = handlers(ctx).get(url)!;
    mocks.quota.isQuotaProvider.mockReturnValueOnce(false);
    const unsupported = await handler(event(JSON.stringify({ userId: "u", provider: "p", accountId: "a" })));
    assert.equal(unsupported.status, 200);
    assert.equal(((await unsupported.json()) as { success: boolean }).success, false);

    mocks.db.getQuotaAccount.mockResolvedValueOnce(null);
    assert.equal((await handler(event(JSON.stringify({ userId: "u", provider: "p", accountId: "a" })))).status, 404);
  });

  it("returns quota data and handles failures", async () => {
    const ctx = context();
    const handler = handlers(ctx).get(url)!;
    mocks.db.getQuotaAccount.mockResolvedValue({ id: "a", userId: "u", provider: "p", projectId: null, accountId: null, tier: null, accessToken: "t" });
    mocks.quota.fetchAccountQuota.mockImplementationOnce(async (quotaContext: { journal: { get: (key: string) => Promise<unknown>; set: (key: string, value: string, ttl: number) => Promise<void> }; fetch: (url: string) => Promise<unknown>; decrypt: (value: string) => string; getCredentials: (account: unknown) => Promise<string> }) => {
      await quotaContext.journal.get("k");
      await quotaContext.journal.set("k", "v", 10);
      await quotaContext.fetch("https://8.8.8.8/x");
      quotaContext.decrypt("v");
      await quotaContext.getCredentials({ id: "a" });
      return { groups: [] };
    });
    const ok = await handler(event(JSON.stringify({ userId: "u", provider: "p", accountId: "a", forceRefresh: true })));
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { success: boolean }).success, true);
    assert.equal((ctx.redis.get as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.equal((ctx.redis.set as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.equal((ctx.guardedFetch as ReturnType<typeof vi.fn>).mock.calls.length, 1);
    assert.equal((ctx.service.quotaCredentials as ReturnType<typeof vi.fn>).mock.calls.length, 1);

    mocks.quota.fetchAccountQuota.mockRejectedValueOnce(new Error("quota down"));
    const failed = await handler(event(JSON.stringify({ userId: "u", provider: "p", accountId: "a" })));
    assert.equal(((await failed.json()) as { error: string }).error, "quota down");
  });
});

describe("routes/internal refresh", () => {
  const url = "POST /internal/refresh";

  it("validates signatures and targets", async () => {
    const ctx = context();
    const handler = handlers(ctx).get(url)!;

    mocks.sig.validateInternalSignature.mockResolvedValueOnce(false);
    assert.equal((await handler(event("{}"))).status, 401);

    assert.equal((await handler(event("not json"))).status, 400);
    assert.equal((await handler(event(JSON.stringify({})))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ url: "http://example.com" })))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ url: "not a url" })))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ url: "https://127.0.0.1/x" })))).status, 400);
    assert.equal((await handler(event(JSON.stringify({ url: "https://8.8.8.8/x", method: "TRACE" })))).status, 400);
  });

  it("relays requests and filters headers", async () => {
    const ctx = context();
    const handler = handlers(ctx).get(url)!;
    const response = await handler(
      event(
        JSON.stringify({
          url: "https://8.8.8.8/refresh",
          method: "post",
          headers: { Authorization: "Bearer x", Host: "evil", "X-Proxy-Thing": "1", "  ": "x", "content-length": "5", "X-Empty": "" },
          body: { a: 1 },
        })
      )
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "upstream");
    assert.equal(response.headers.get("set-cookie"), null);
    const init = (ctx.guardedFetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    assert.equal(init.method, "POST");
    const headers = init.headers as Headers;
    assert.equal(headers.get("host"), null);
    assert.equal(headers.get("x-proxy-thing"), "1");
    assert.equal(headers.get("authorization"), "Bearer x");
    assert.equal(init.body, JSON.stringify({ a: 1 }));
  });

  it("reports relay upstream failures", async () => {
    const ctx = context({ guardedFetch: vi.fn(async () => { throw new Error("network"); }) });
    const handler = handlers(ctx).get(url)!;
    const response = await handler(event(JSON.stringify({ url: "https://8.8.8.8/x" })));
    assert.equal(response.status, 502);
  });

  it("rejects oversized relay bodies", async () => {
    const ctx = context();
    const handler = handlers(ctx).get(url)!;
    const response = await handler(event("x".repeat((2 << 20) + 1)));
    assert.equal(response.status, 400);
  });
});
