import { describe, expect, it } from "bun:test";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { Effect } from "effect";
import type { Provider, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/core/redis";
import { ProxyService } from "@opendum/api/core/service";
import { Chat } from "@opendum/api/core/endpoints";
import { ModelSaturation, isSaturated } from "@opendum/api/core/model-saturation";
import { fakes } from "@opendum/api/test/fakes";

function memoryRedis(): OpendumRedis {
  const store = new Map<string, string>();
  const expiries = new Map<string, number>();
  const alive = (key: string): boolean => {
    const until = expiries.get(key);
    if (until === undefined) return true;
    if (until > Date.now()) return true;
    store.delete(key);
    expiries.delete(key);
    return false;
  };
  return {
    get: async (key: string) => (alive(key) ? store.get(key) ?? null : null),
    set: async (key: string, value: string, options?: { EX?: number; PX?: number }) => {
      store.set(key, value);
      if (options?.PX) expiries.set(key, Date.now() + options.PX);
      else if (options?.EX) expiries.set(key, Date.now() + options.EX * 1000);
      else expiries.delete(key);
      return "OK";
    },
    del: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      let removed = 0;
      for (const key of list) {
        if (store.delete(key)) removed += 1;
        expiries.delete(key);
      }
      return removed;
    },
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? "0") + 1;
      store.set(key, String(next));
      return next;
    },
    expire: async () => true,
    pTTL: async (key: string) => {
      if (!alive(key)) return -2;
      const until = expiries.get(key);
      return until === undefined ? -1 : Math.max(1, until - Date.now());
    },
    zAdd: async () => 1,
    zRemRangeByRank: async () => 0,
  } as unknown as OpendumRedis;
}

function validAuth(): AuthResult {
  return {
    valid: true,
    userId: "user-1",
    apiKeyId: "key-1",
    modelAccessMode: "all",
    modelAccessList: [],
    accountAccessMode: "all",
    accountAccessList: [],
    roamingEnabled: false,
    rateLimitRules: [],
    error: "",
  };
}

function validModel(): ModelValidationResult {
  return {
    valid: true,
    provider: "workbuddy",
    model: "deepseek-v4.1-flash",
    alias: "",
    vision: null,
    error: "",
    param: "",
    code: "",
  };
}

const SATURATED_BODY = JSON.stringify({
  code: 14003,
  msg: "too many requests",
  displayMsg: { en: "Model busy. Please switch models or retry later" },
  actions: ["SWITCH_MODEL", "SUBMIT_FEEDBACK", "RETRY"],
});

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

type Harness = {
  seen: string[];
  call: () => Promise<Response>;
  repositories: ReturnType<typeof fakes>;
};

type Reply = number | { status: number; body: string };

function harness(statuses: Reply[]): Harness {
  const seen: string[] = [];
  const queue = [...statuses];
  const provider: Provider = {
    name: "workbuddy",
    makeRequest: (request) => {
      seen.push(request.account.id);
      const reply = queue.length > 0 ? queue.shift() ?? 200 : 200;
      if (reply === 200) {
        return Effect.succeed(
          new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })
        );
      }
      const status = typeof reply === "number" ? reply : reply.status;
      const body = typeof reply === "number" ? SATURATED_BODY : reply.body;
      return Effect.succeed(new Response(body, { status }));
    },
  };
  const providers = {
    names: () => ["workbuddy"],
    has: (name: string) => name === "workbuddy",
    get: (name: string) => (name === "workbuddy" ? provider : undefined),
    isAuthless: () => false,
    refreshableProviderNames: () => [],
    transport: { direct: () => Promise.reject(new Error("no fetch")) },
  } as unknown as ProviderRegistry;
  const models = {
    providers: () => ["workbuddy"],
    resolveAlias: (model: string) => model,
    lookupKeys: (model: string) => [model],
    isVisionModel: () => true,
    supportsProvider: () => true,
    isAuthless: () => false,
    rule: () => null,
    modelCost: () => null,
    models: () => [],
  } as unknown as Registry;
  const auth = {
    validateKey: () => Effect.succeed(validAuth()),
    validateFor: () => Effect.succeed(validModel()),
    bumpVersion: () => Effect.void,
  } as unknown as AuthService;

  const repositories = fakes();
  repositories.accounts.listEligibleAccounts.mockImplementation((params) =>
    Effect.succeed([
      {
        id: "acc-1",
        userId: "user-1",
        provider: "workbuddy",
        accountId: "uid-1",
        status: "active",
        tier: null,
        disabledUntil: null,
        lastUsedAt: null,
        createdAt: new Date(),
      },
      {
        id: "acc-2",
        userId: "user-1",
        provider: "workbuddy",
        accountId: "uid-2",
        status: "active",
        tier: null,
        disabledUntil: null,
        lastUsedAt: null,
        createdAt: new Date(),
      },
    ].filter((row) => !params.excludeIds.includes(row.id)) as never)
  );

  const service = new ProxyService({
    database: {} as never,
    repositories,
    redis: memoryRedis(),
    models,
    auth,
    providers,
    betterAuthSecret: "secret",
    requestTimeoutMs: 0,
    saturation: { baseDelayMs: 20, maxDelayMs: 40, random: () => 0 },
  });

  return {
    seen,
    repositories,
    call: () =>
      service.handle(
        new Chat(),
        { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true },
        "Bearer ok",
        "sess-1"
      ),
  };
}

describe("isSaturated", () => {
  it("detects the workbuddy saturation code", () => {
    expect(isSaturated(429, SATURATED_BODY)).toBe(true);
  });

  it("detects the saturation message without a known status", () => {
    expect(isSaturated(503, JSON.stringify({ msg: "模型繁忙" }))).toBe(true);
  });

  it("ignores ordinary rate limits and request errors", () => {
    expect(isSaturated(429, JSON.stringify({ code: 11148, msg: "rate limited" }))).toBe(false);
    expect(isSaturated(400, "bad request")).toBe(false);
    expect(isSaturated(500, "")).toBe(false);
  });
});

describe("model saturation handling", () => {
  it("retries the same account instead of rotating on saturation", async () => {
    const { seen, call, repositories } = harness([429, 200]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-1"]);
    expect(repositories.health.recordRequestError.mock.calls.length).toBe(0);
    expect(repositories.health.markUsageLimited.mock.calls.length).toBe(0);
    expect(repositories.health.markLimited.mock.calls.length).toBe(0);
  });

  it("clears the cooldown after a successful retry so the next turn does not wait", async () => {
    const { seen, call } = harness([429, 200, 200]);
    const first = await call();
    await first.text();
    expect(first.status).toBe(200);
    const startedAt = Date.now();
    const second = await call();
    await second.text();
    expect(second.status).toBe(200);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(seen).toEqual(["acc-1", "acc-1", "acc-1"]);
  });

  it("still rotates accounts for an ordinary rate limit", async () => {
    const { seen, call } = harness([{ status: 429, body: JSON.stringify({ code: 11148, msg: "rate limited" }) }, 200]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2"]);
  });

  it("returns a rate limit with retry metadata once the retry budget is spent", async () => {
    const { seen, call, repositories } = harness([429, 429, 429, 429]);
    const response = await call();
    expect(response.status).toBe(429);
    expect(seen).toEqual(["acc-1", "acc-1", "acc-1"]);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    const body = (await response.json()) as { error: { retry_after_ms: number } };
    expect(body.error.retry_after_ms).toBeGreaterThan(0);
    expect(repositories.health.recordRequestError.mock.calls.length).toBe(0);
  });
});

describe("ModelSaturation", () => {
  it("grows the cooldown and clears it after a success", async () => {
    const saturation = new ModelSaturation(memoryRedis(), { baseDelayMs: 100, random: () => 0 });
    const first = await Effect.runPromise(saturation.hold("workbuddy", "deepseek-v4.1-flash"));
    const second = await Effect.runPromise(saturation.hold("workbuddy", "deepseek-v4.1-flash"));
    expect(first).toBe(100);
    expect(second).toBe(200);
    const remaining = await Effect.runPromise(saturation.remaining("workbuddy", "deepseek-v4.1-flash"));
    expect(remaining).toBeGreaterThan(0);
    await Effect.runPromise(saturation.clear("workbuddy", "deepseek-v4.1-flash"));
    expect(await Effect.runPromise(saturation.remaining("workbuddy", "deepseek-v4.1-flash"))).toBe(0);
  });

  it("keeps cooldowns separate per provider and model", async () => {
    const saturation = new ModelSaturation(memoryRedis(), { baseDelayMs: 5000, random: () => 0 });
    await Effect.runPromise(saturation.hold("workbuddy", "model-a"));
    expect(await Effect.runPromise(saturation.remaining("workbuddy", "model-a"))).toBeGreaterThan(0);
    expect(await Effect.runPromise(saturation.remaining("workbuddy", "model-b"))).toBe(0);
    expect(await Effect.runPromise(saturation.remaining("opencode", "model-a"))).toBe(0);
  });
});
