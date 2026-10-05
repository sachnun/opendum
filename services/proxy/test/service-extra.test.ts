import assert from "node:assert/strict";
import { beforeEach, describe, it, vi } from "vitest";
import type { AuthResult } from "@opendum/auth";

const mocks = vi.hoisted(() => ({
  routing: { executeWithAccountRotation: vi.fn(), modelAccountSelector: vi.fn(), validateForcedAccount: vi.fn() },
  creds: { customProviderForAccount: vi.fn(), quotaCredentials: vi.fn(), startTokenRefresher: vi.fn() },
  health: {
    markAccountsRecoveredByRotation: vi.fn(),
    recordResponseHandlerFailure: vi.fn(),
    recordSuccessfulRequest: vi.fn(),
    storeHypercreditsUsage: vi.fn(),
  },
  ratelimit: { checkAndIncrementAPIKeyRateLimit: vi.fn() },
  points: {
    adjustRoamingPoints: vi.fn(),
    creditSharingPoint: vi.fn(),
    refundRoamingPoint: vi.fn(),
    roamingPoints: vi.fn(),
    settleRoamingPoint: vi.fn(),
  },
}));

vi.mock("../src/core/service-routing.js", () => mocks.routing);
vi.mock("../src/core/service-credentials.js", () => mocks.creds);
vi.mock("../src/core/service-health.js", () => mocks.health);
vi.mock("../src/core/ratelimit.js", () => mocks.ratelimit);
vi.mock("../src/core/points.js", () => mocks.points);

import { ProxyService, cloneMap, extractSessionId } from "../src/core/service.js";
import type { AttemptResult, EndpointAdapter, ParsedEndpointRequest } from "../src/core/types.js";

function authResult(overrides: Partial<AuthResult> = {}): AuthResult {
  return {
    valid: true,
    userId: "u1",
    apiKeyId: "k1",
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    rateLimitRules: [],
    error: "",
    ...overrides,
  };
}

function service(overrides: Record<string, unknown> = {}): ProxyService {
  return new ProxyService({
    database: {},
    redis: {},
    models: {},
    auth: { validateAPIKey: vi.fn(async () => authResult()), validateModelForUser: vi.fn(async () => ({ valid: true, model: "m", provider: null, param: "", code: "", error: "" })) },
    providers: { names: () => [] },
    betterAuthSecret: "secret",
    requestTimeoutMs: 0,
    ...overrides,
  } as never);
}

function parsed(overrides: Partial<ParsedEndpointRequest> = {}): ParsedEndpointRequest {
  return { modelParam: "m", stream: false, forcedAccountId: null, reasoningRequested: false, messagesForError: [], paramsForError: {}, routeData: {}, ...overrides };
}

function cfg(overrides: Record<string, unknown> = {}): EndpointAdapter {
  return {
    endpoint: "chat_completions",
    format: "openai",
    rateLimitStatusCode: 429,
    noAccountsStatusCode: 503,
    parse: () => parsed(),
    build: () => ({}),
    handleStream: vi.fn(async () => new Response("stream", { status: 200 })),
    handleNonStream: vi.fn(async () => new Response("ok", { status: 200 })),
    ...overrides,
  } as unknown as EndpointAdapter;
}

function attempt(overrides: Partial<AttemptResult> = {}): AttemptResult {
  return {
    account: { id: "a1", userId: "u1", provider: "kiro", isActive: true, status: "active" },
    response: new Response("ok", { status: 200 }),
    requestStartMs: Date.now(),
    upstreamFirstResponseMs: Date.now(),
    rotationFailures: [],
    roaming: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.routing.modelAccountSelector.mockResolvedValue(null);
  mocks.routing.validateForcedAccount.mockResolvedValue(null);
  mocks.routing.executeWithAccountRotation.mockResolvedValue(attempt());
  mocks.ratelimit.checkAndIncrementAPIKeyRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0, exceededWindow: "", limit: 0, current: 0 });
  mocks.points.settleRoamingPoint.mockResolvedValue(undefined);
  mocks.points.refundRoamingPoint.mockResolvedValue(undefined);
  mocks.health.recordResponseHandlerFailure.mockResolvedValue(undefined);
  mocks.health.markAccountsRecoveredByRotation.mockResolvedValue(undefined);
});

describe("routeError", () => {
  it("builds openai and anthropic errors", async () => {
    const svc = service();
    const openai = svc.routeError(cfg(), { status: 429, message: "slow", type: "rate_limit_error", accountId: "a1", retryAfter: "2s", retryAfterMs: 2000 });
    assert.equal(openai.status, 429);
    assert.equal(openai.headers.get("X-Provider-Account-Id"), "a1");
    assert.equal(openai.headers.get("Retry-After"), "2");
    const openaiBody = (await openai.json()) as { error: Record<string, unknown> };
    assert.equal(openaiBody.error.message, "slow");
    assert.equal(openaiBody.error.retry_after, "2s");

    const anthropic = svc.routeError(cfg({ format: "anthropic" }), { status: 500, message: "boom", type: "api_error", retryAfterMs: 1500 });
    const anthropicBody = (await anthropic.json()) as { type: string; error: Record<string, unknown> };
    assert.equal(anthropicBody.type, "error");
    assert.equal(anthropicBody.error.retry_after_ms, 1500);

    const retryAfter = svc.routeError(cfg({ format: "anthropic" }), { status: 429, message: "slow", type: "rate_limit_error", retryAfter: "3s" });
    assert.equal(((await retryAfter.json()) as { error: Record<string, unknown> }).error.retry_after, "3s");
  });
});

describe("playground auth", () => {
  it("rejects partial playground headers", async () => {
    const svc = service();
    const request = new Request("https://proxy/v1/chat/completions", { headers: { "x-opendum-playground-user-id": "u1" } });
    const response = await svc.handle(cfg(), {}, "", "s", request);
    assert.equal(response.status, 401);
  });

  it("accepts signed playground sessions", async () => {
    const { playgroundSignature } = await import("@opendum/crypto");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = playgroundSignature("secret", "u1", timestamp, "POST", "/v1/chat/completions");
    const request = new Request("https://proxy/v1/chat/completions", {
      method: "POST",
      headers: { "x-opendum-playground-user-id": "u1", "x-opendum-playground-timestamp": timestamp, "x-opendum-playground-signature": signature },
    });
    const svc = service();
    const response = await svc.handle(cfg(), {}, "", "s", request);
    assert.equal(response.status, 200);
  });
});

describe("handle stream and non-stream flows", () => {
  it("settles roaming points on stream success", async () => {
    const svc = service();
    const roaming = { userId: "u1", model: "m", amount: 1, debitId: "d1" };
    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming }));
    const streamCfg = cfg({
      parse: () => parsed({ stream: true }),
      handleStream: vi.fn(async (ctx: { streamHandled?: boolean; onStreamComplete?: (reason: string) => void }) => {
        ctx.streamHandled = true;
        ctx.onStreamComplete?.("success");
        return new Response("stream", { status: 200 });
      }),
    });
    await svc.handle(streamCfg, {}, "", "s");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mocks.points.settleRoamingPoint.mock.calls.length, 1);
  });

  it("refunds and records stream errors", async () => {
    const svc = service();
    const roaming = { userId: "u1", model: "m", amount: 1, debitId: "d1" };
    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming }));
    const streamCfg = cfg({
      parse: () => parsed({ stream: true }),
      handleStream: vi.fn(async (ctx: { streamHandled?: boolean; onStreamComplete?: (reason: string) => void }) => {
        ctx.streamHandled = true;
        ctx.onStreamComplete?.("error");
        return new Response("stream", { status: 200 });
      }),
    });
    await svc.handle(streamCfg, {}, "", "s");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mocks.points.refundRoamingPoint.mock.calls.length >= 1, true);
    assert.equal(mocks.health.recordResponseHandlerFailure.mock.calls.length, 1);
  });

  it("settles when streams are not handled by the recorder", async () => {
    const svc = service();
    const roaming = { userId: "u1", model: "m", amount: 1, debitId: "d1" };
    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming, rotationFailures: [{ accountId: "a1", failedAt: new Date() }] }));
    const streamCfg = cfg({ parse: () => parsed({ stream: true }) });
    await svc.handle(streamCfg, {}, "", "s");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mocks.points.settleRoamingPoint.mock.calls.length, 1);
    assert.equal(mocks.health.markAccountsRecoveredByRotation.mock.calls.length, 1);
  });

  it("handles non-stream failures", async () => {
    const svc = service();
    const roaming = { userId: "u1", model: "m", amount: 1, debitId: "d1" };
    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming }));
    const failing = cfg({ handleNonStream: vi.fn(async () => { throw new Error("handler exploded"); }) });
    const response = await svc.handle(failing, {}, "", "s");
    assert.equal(response.status, 500);
    assert.equal(mocks.points.refundRoamingPoint.mock.calls.length, 1);
    assert.equal(mocks.health.recordResponseHandlerFailure.mock.calls.length, 1);
  });

  it("settles roaming points on non-stream success", async () => {
    const svc = service();
    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming: { userId: "u1", model: "m", amount: 1, debitId: "d1" } }));
    await svc.handle(cfg(), {}, "", "s");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(mocks.points.settleRoamingPoint.mock.calls.length, 1);
  });
});

describe("delegates", () => {
  it("forwards helper calls", async () => {
    const svc = service();
    mocks.creds.quotaCredentials.mockResolvedValueOnce("token");
    mocks.creds.customProviderForAccount.mockResolvedValueOnce({ name: "custom" });
    mocks.creds.startTokenRefresher.mockResolvedValueOnce(undefined);
    svc.storeHypercreditsUsage("a1", 5, 1);
    svc.recordSuccessfulRequest({
      accountId: "a1",
      provider: "p",
      model: "m",
      userId: "u1",
      apiKeyId: "k1",
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 1,
      stream: false,
      requestStartMs: 0,
      upstreamFirstResponseMs: 0,
    });
    assert.equal(await svc.quotaCredentials({ id: "a1", userId: "u1", provider: "kiro" }), "token");
    assert.equal((await svc.customProviderForAccount("u1", "custom"))?.name, "custom");
    await svc.startTokenRefresher(new AbortController().signal, 1000);
    assert.equal(mocks.health.storeHypercreditsUsage.mock.calls.length, 1);
    assert.equal(mocks.health.recordSuccessfulRequest.mock.calls.length, 1);
  });

  it("re-exports helpers", () => {
    assert.deepEqual(cloneMap({ a: 1 }), { a: 1 });
    const request = new Request("https://x", { headers: { "x-session-id": "s1" } });
    assert.equal(extractSessionId(request, {}), "s1");
  });
});

describe("handle edge branches", () => {
  it("returns parse and forced-account errors", async () => {
    const svc = service();
    const parseError = cfg({ parse: () => ({ status: 400, message: "bad", type: "invalid_request_error" }) });
    assert.equal((await svc.handle(parseError, {}, "", "s")).status, 400);

    mocks.routing.modelAccountSelector.mockResolvedValueOnce({ accountId: "a1", model: "m2" });
    mocks.routing.validateForcedAccount.mockResolvedValueOnce({ status: 403, message: "denied", type: "invalid_request_error" });
    assert.equal((await svc.handle(cfg(), {}, "", "s")).status, 403);
  });

  it("validates playground headers", async () => {
    const svc = service();
    assert.equal((await svc.handle(cfg(), {}, "", "s", new Request("https://x"))).status, 200);

    const partial = new Request("https://x", { headers: { "x-opendum-playground-user-id": "u1" } });
    assert.equal((await svc.handle(cfg(), {}, "", "s", partial)).status, 401);

    const badTimestamp = new Request("https://x", {
      headers: { "x-opendum-playground-user-id": "u1", "x-opendum-playground-timestamp": "abc", "x-opendum-playground-signature": "x" },
    });
    assert.equal((await svc.handle(cfg(), {}, "", "s", badTimestamp)).status, 401);

    const wrongSignature = new Request("https://x", {
      headers: { "x-opendum-playground-user-id": "u1", "x-opendum-playground-timestamp": String(Math.floor(Date.now() / 1000)), "x-opendum-playground-signature": "wrong" },
    });
    assert.equal((await svc.handle(cfg(), {}, "", "s", wrongSignature)).status, 401);
  });

  it("accepts playground sessions with unparseable urls", async () => {
    const { playgroundSignature } = await import("@opendum/crypto");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = playgroundSignature("secret", "u1", timestamp, "POST", "/");
    const request = { url: "::", method: "POST", headers: new Headers({ "x-opendum-playground-user-id": "u1", "x-opendum-playground-timestamp": timestamp, "x-opendum-playground-signature": signature }) } as unknown as Request;
    const response = await service().handle(cfg(), {}, "", "s", request);
    assert.equal(response.status, 200);
  });

  it("swallows deferred helper failures", async () => {
    const roaming = { userId: "u1", model: "m", amount: 1, debitId: "d1" };
    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming }));
    mocks.points.settleRoamingPoint.mockRejectedValueOnce(new Error("down"));
    mocks.health.markAccountsRecoveredByRotation.mockRejectedValueOnce(new Error("down"));
    const response = await service().handle(cfg(), {}, "", "s");
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 5));

    mocks.routing.executeWithAccountRotation.mockResolvedValueOnce(attempt({ roaming }));
    mocks.points.refundRoamingPoint.mockRejectedValueOnce(new Error("down"));
    const failing = cfg({ handleNonStream: vi.fn(async () => { throw new Error("boom"); }) });
    assert.equal((await service().handle(failing, {}, "", "s")).status, 500);
  });
});
