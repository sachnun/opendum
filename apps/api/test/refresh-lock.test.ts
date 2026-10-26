import { describe, expect, it } from "bun:test";
import type { AuthService } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/core/redis";

import { ProxyService } from "@opendum/api/core/service";
import { fakes } from "@opendum/api/test/fakes";
import { raise } from "@opendum/core/raise";

type Service = InstanceType<typeof ProxyService>;

const LOCK_KEY = "opendum:provider-account:refresh-lock:acc-1";

function redis(evalImpl: (script: string, options: { keys?: string[]; arguments?: string[] }) => Promise<unknown>): OpendumRedis {
  return {
    get: async () => null,
    set: async () => "OK",
    del: async () => 1,
    eval: evalImpl,
  } as unknown as OpendumRedis;
}

function serviceWith(redisClient: OpendumRedis): Service {
  return new ProxyService({
    database: {} as never,
    repositories: fakes(),
    redis: redisClient,
    models: {} as never,
    auth: {} as AuthService,
    providers: { names: () => [] } as never,
    betterAuthSecret: "secret",
    requestTimeoutMs: 0,
  });
}

function release(service: Service, accountId: string, value: string): Promise<void> {
  return (service as unknown as { releaseRefreshLock: (id: string, v: string) => Promise<void> }).releaseRefreshLock(
    accountId,
    value
  );
}

describe("refresh lock release", () => {
  it("releases with an atomic compare and delete", async () => {
    const calls: Array<{ script: string; keys?: string[]; arguments?: string[] }> = [];
    const service = serviceWith(
      redis(async (script, options) => {
        calls.push({ script, ...options });
        return 1;
      })
    );

    await release(service, "acc-1", "lock-value");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.keys).toEqual([LOCK_KEY]);
    expect(calls[0]?.arguments).toEqual(["lock-value"]);
    expect(calls[0]?.script).toContain("GET");
    expect(calls[0]?.script).toContain("DEL");
  });

  it("guards the delete behind a value comparison", async () => {
    const deleted: string[] = [];
    let script = "";
    const service = serviceWith({
      ...redis(async (source) => {
        script = source;
        return 0;
      }),
      del: async (key: string) => {
        deleted.push(key);
        return 1;
      },
    } as unknown as OpendumRedis);

    await release(service, "acc-1", "stale-value");

    expect(deleted).toEqual([]);
    expect(script).toContain("redis.call(\"GET\", KEYS[1]) == ARGV[1]");
  });

  it("skips the call when the lock value is empty", async () => {
    let called = false;
    const service = serviceWith(
      redis(async () => {
        called = true;
        return 1;
      })
    );

    await release(service, "acc-1", "");

    expect(called).toBe(false);
  });

  it("swallows redis failures", async () => {
    const service = serviceWith(
      redis(async () => {
        raise(new Error("redis down"));
      })
    );

    await expect(release(service, "acc-1", "lock-value")).resolves.toBeUndefined();
  });
});
