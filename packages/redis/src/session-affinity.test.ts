import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpendumRedis } from "#redis/client.ts";
import { SESSION_AFFINITY_PREFIX } from "#redis/keys.ts";
import { preferSticky, SessionAffinity } from "#redis/session-affinity.ts";

type SetOptions = { EX?: number };

function fakeRedis(options: { getValue?: (key: string) => string | null; fail?: boolean } = {}) {
  const sets: Array<{ key: string; value: string; options?: SetOptions }> = [];
  const redis = {
    async get(key: string) {
      if (options.fail) throw new Error("redis down");
      return options.getValue ? options.getValue(key) : null;
    },
    async set(key: string, value: string, setOptions?: SetOptions) {
      if (options.fail) throw new Error("redis down");
      sets.push({ key, value, options: setOptions });
      return "OK";
    },
  };
  return { redis: redis as unknown as OpendumRedis, sets };
}

describe("SessionAffinity", () => {
  it("normalizes provider names and reports enabled state", () => {
    const { redis } = fakeRedis();
    const affinity = new SessionAffinity(redis, [" antigravity ", "", "kiro"]);
    assert.equal(affinity.enabled("antigravity"), true);
    assert.equal(affinity.enabled(" antigravity "), true);
    assert.equal(affinity.enabled("other"), false);
  });

  it("looks up a stored account", async () => {
    const { redis } = fakeRedis({
      getValue: (key) => (key === `${SESSION_AFFINITY_PREFIX}:u1:s1` ? "acct-9" : null),
    });
    const affinity = new SessionAffinity(redis, ["antigravity"]);
    assert.equal(await affinity.lookup("u1", "s1"), "acct-9");
    assert.equal(await affinity.lookup("u1", "missing"), "");
  });

  it("returns empty for invalid pairs", async () => {
    const { redis } = fakeRedis({ getValue: () => "acct-9" });
    const affinity = new SessionAffinity(redis, []);
    assert.equal(await affinity.lookup("", "s1"), "");
    assert.equal(await affinity.lookup("   ", "s1"), "");
    assert.equal(await affinity.lookup("u1", "  "), "");
  });

  it("swallows redis errors", async () => {
    const { redis } = fakeRedis({ fail: true });
    const affinity = new SessionAffinity(redis, []);
    assert.equal(await affinity.lookup("u1", "s1"), "");
    await assert.doesNotReject(affinity.store("u1", "s1", "acct-1"));
  });

  it("stores with the configured ttl", async () => {
    const { redis, sets } = fakeRedis();
    const affinity = new SessionAffinity(redis, [], 1234);
    await affinity.store("u1", "s1", "acct-1");
    assert.deepEqual(sets, [
      { key: `${SESSION_AFFINITY_PREFIX}:u1:s1`, value: "acct-1", options: { EX: 1234 } },
    ]);
  });

  it("skips storing invalid pairs or a blank account", async () => {
    const { redis, sets } = fakeRedis();
    const affinity = new SessionAffinity(redis, []);
    await affinity.store("", "s1", "acct-1");
    await affinity.store("u1", "", "acct-1");
    await affinity.store("u1", "s1", "  ");
    assert.equal(sets.length, 0);
  });
});

describe("preferSticky", () => {
  it("moves the sticky item to the front", () => {
    assert.deepEqual(preferSticky([1, 2, 3], (item) => item === 2), [2, 1, 3]);
  });

  it("is a no-op when the sticky item is already first", () => {
    const items = [1, 2, 3];
    assert.equal(preferSticky(items, (item) => item === 1), items);
  });

  it("is a no-op when no item matches", () => {
    const items = [1, 2, 3];
    assert.equal(preferSticky(items, () => false), items);
  });

  it("handles empty arrays", () => {
    assert.deepEqual(preferSticky<number>([], () => true), []);
  });
});
