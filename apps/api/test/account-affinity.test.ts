import { describe, expect, it } from "bun:test";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { Effect } from "effect";
import type { Provider, ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import { AccountAffinity, type OpendumRedis } from "@opendum/core/redis";
import { ProxyService } from "../core/service.js";
import { Chat } from "../core/endpoints.js";
import { fakes } from "./fakes.js";

function memoryRedis(): OpendumRedis {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    zAdd: async () => 1,
    zRemRangeByRank: async () => 0,
    expire: async () => true,
    keys: async () => [...store.keys()],
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

function accountRow(id: string) {
  return {
    id,
    userId: "user-1",
    provider: "workbuddy",
    accountId: `uid-${id}`,
    status: "active",
    tier: null,
    disabledUntil: null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
}

type Harness = {
  seen: string[];
  call: (sessionId: string) => Promise<number>;
};

function harness(): Harness {
  const seen: string[] = [];
  const provider: Provider = {
    name: "workbuddy",
    makeRequest: (request) => {
      seen.push(request.account.id);
      if (request.account.id === "acc-1") {
        return Effect.succeed(
          new Response(JSON.stringify({ code: 11148, msg: "rate limited" }), { status: 429 })
        );
      }
      return Effect.succeed(
        new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      );
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
    isSupportedByProvider: () => true,
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
    Effect.succeed(
      [accountRow("acc-1"), accountRow("acc-2")].filter((row) => !params.excludeIds.includes(row.id))
    )
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
  });

  const call = async (sessionId: string) => {
    const response = await service.handle(
      new Chat(),
      { model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: true },
      "Bearer ok",
      sessionId
    );
    await response.text();
    return response.status;
  };

  return { seen, call };
}

describe("account stickiness across requests", () => {
  it("stays on the replacement account after a rate limited account fails", async () => {
    const { seen, call } = harness();
    expect(await call("sess-1")).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2"]);
    seen.length = 0;
    expect(await call("sess-1")).toBe(200);
    expect(seen[0]).toBe("acc-2");
  });

  it("stays on the replacement account when the client sends no session id", async () => {
    const { seen, call } = harness();
    expect(await call("")).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2"]);
    seen.length = 0;
    expect(await call("")).toBe(200);
    expect(seen[0]).toBe("acc-2");
  });

  it("stays on the replacement account when the client session id changes", async () => {
    const { seen, call } = harness();
    expect(await call("sess-a")).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2"]);
    seen.length = 0;
    expect(await call("sess-b")).toBe(200);
    expect(seen[0]).toBe("acc-2");
  });

  it("sticks to the replacement account for new sessions", async () => {
    const { seen, call } = harness();
    expect(await call("sess-a")).toBe(200);
    expect(await call("sess-b")).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2", "acc-2"]);
  });
});

describe("AccountAffinity primary account", () => {
  it("stores and looks up the pinned account per user", async () => {
    const affinity = new AccountAffinity(memoryRedis(), ["workbuddy"]);
    expect(await Effect.runPromise(affinity.lookup("user-1"))).toBe("");
    await Effect.runPromise(affinity.store("user-1", "acc-9"));
    expect(await Effect.runPromise(affinity.lookup("user-1"))).toBe("acc-9");
    expect(await Effect.runPromise(affinity.lookup("user-2"))).toBe("");
  });

  it("ignores blank users and accounts", async () => {
    const affinity = new AccountAffinity(memoryRedis(), ["workbuddy"]);
    await Effect.runPromise(affinity.store("  ", "acc-9"));
    expect(await Effect.runPromise(affinity.lookup("  "))).toBe("");
    await Effect.runPromise(affinity.store("user-1", "  "));
    expect(await Effect.runPromise(affinity.lookup("user-1"))).toBe("");
  });
});
