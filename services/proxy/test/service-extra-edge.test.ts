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

vi.mock("../src/core/selection/service-routing.ts", () => mocks.routing);
vi.mock("../src/core/service-credentials.ts", () => mocks.creds);
vi.mock("../src/core/health/service-health.ts", () => mocks.health);
vi.mock("../src/core/metering/ratelimit.ts", () => mocks.ratelimit);
vi.mock("../src/core/metering/points.ts", () => mocks.points);

import { ProxyService } from "../src/core/service.ts";
import type { AttemptResult, EndpointAdapter, ParsedEndpointRequest } from "../src/core/types.ts";

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
