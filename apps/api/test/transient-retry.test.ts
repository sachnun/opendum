import { describe, expect, it } from "bun:test";
import type { AuthResult, AuthService, ModelValidationResult } from "@opendum/auth";
import { Effect } from "effect";
import { ProviderTransportFailure, type Provider, type ProviderRegistry } from "@opendum/providers";
import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/platform/redis";
import { ProxyService } from "@opendum/api/proxy/service";
import { Chat } from "@opendum/api/proxy/endpoints";
import { fakes } from "@opendum/api/test/fakes";

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';

function memoryRedis(): OpendumRedis {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    del: async (key: string) => (store.delete(key) ? 1 : 0),
    incr: async (key: string) => {
      const next = Number(store.get(key) ?? "0") + 1;
      store.set(key, String(next));
      return next;
    },
    pTTL: async () => -1,
    expire: async () => true,
    zAdd: async () => 1,
    zRemRangeByRank: async () => 0,
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

type Reply = { status: number; body: string } | "ok" | "throw";

type Harness = {
  seen: string[];
  call: () => Promise<Response>;
  repositories: ReturnType<typeof fakes>;
};

function harness(replies: Array<Reply>, accounts = ["acc-1", "acc-2"]): Harness {
  const seen: string[] = [];
  const queue = [...replies];
  const provider: Provider = {
    name: "workbuddy",
    makeRequest: (request) => {
      seen.push(request.account.id);
      const reply = queue.shift() ?? "ok";
      if (reply === "throw") return Effect.fail(new ProviderTransportFailure({
        message: "fetch failed",
        provider: "workbuddy",
        url: "https://www.workbuddy.ai/v2/chat/completions",
      }));
      if (reply === "ok") {
        return Effect.succeed(
          new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } })
        );
      }
      return Effect.succeed(new Response(reply.body, { status: reply.status }));
    },
  };
  const providers = {
    names: () => ["workbuddy"],
    has: (name: string) => name === "workbuddy",
    get: (name: string) => (name === "workbuddy" ? provider : undefined),
    isAuthless: () => false,
    refreshableProviderNames: () => [],
    transport: { direct: () => Effect.runPromise(Effect.fail(new Error("no fetch"))) },
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
    Effect.succeed(
      accounts.map((id) => accountRow(id)).filter((row) => !params.excludeIds.includes(row.id))
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
    saturation: { baseDelayMs: 5, maxDelayMs: 5, random: () => 0 },
    retry: { maxRetries: 2, delayMs: 1 },
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

const illegalRequest: Reply = {
  status: 403,
  body: JSON.stringify({ code: 11128, msg: "request illegal", requestId: "01a148f043df7ebb90b578cc0b316d5a" }),
};

const serverFault: Reply = { status: 502, body: "<html>502 Bad Gateway</html>" };

describe("transient upstream retry before rotation", () => {
  it("retries the same account on an illegal request instead of rotating", async () => {
    const { seen, call, repositories } = harness([illegalRequest, "ok"]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-1"]);
    expect(repositories.health.markUsageLimited.mock.calls.length).toBe(0);
    expect(repositories.health.markLimited.mock.calls.length).toBe(0);
  });

  it("retries the same account on a temporary server fault", async () => {
    const { seen, call, repositories } = harness([serverFault, "ok"]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-1"]);
    expect(repositories.health.recordRequestError.mock.calls.length).toBe(0);
  });

  it("rotates only after the retry budget is spent", async () => {
    const { seen, call } = harness([serverFault, serverFault, serverFault, "ok"]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-1", "acc-1", "acc-2"]);
  });

  it("retries the same account on a transport failure", async () => {
    const { seen, call, repositories } = harness(["throw", "ok"]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-1"]);
    expect(repositories.health.recordRequestError.mock.calls.length).toBe(0);
  });

  it("surfaces the failure without rotating when no account is left", async () => {
    const { seen, call } = harness([serverFault, serverFault, serverFault, serverFault, serverFault, serverFault]);
    const response = await call();
    expect(response.status).toBe(502);
    expect(seen).toEqual(["acc-1", "acc-1", "acc-1", "acc-2", "acc-2", "acc-2"]);
    await response.text();
  });
});

describe("workbuddy usage limit handling", () => {
  const usageLimit: Reply = {
    status: 429,
    body: JSON.stringify({
      code: 6004,
      msg: "usage exceeds frequency limit, but don't worry, your usage will reset at 2099-10-24 13:34:16 UTC+8, alternatively, you can switch to the other models to continue using it.",
      requestId: "01a16c516848752f86ea4543b9d3b046",
    }),
  };

  it("parks the account until the reset time instead of cooling it down for minutes", async () => {
    const { call, repositories } = harness([usageLimit], ["acc-1"]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(429);
    expect(repositories.health.markUsageLimited.mock.calls.length).toBe(1);
    const limited = repositories.health.markLimited.mock.calls[0]?.[0];
    expect(limited?.id).toBe("acc-1");
    expect(limited?.disabledUntil.toISOString()).toBe("2099-10-24T05:34:16.000Z");
  });

  it("rotates to the next account for the usage limit", async () => {
    const { seen, call } = harness([usageLimit, "ok"]);
    const response = await call();
    await response.text();
    expect(response.status).toBe(200);
    expect(seen).toEqual(["acc-1", "acc-2"]);
  });
});
