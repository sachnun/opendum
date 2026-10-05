import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeRedis, openRedis, type OpendumRedis } from "#redis/index.ts";

describe("redis client exports", () => {
  it("exposes client helpers", () => {
    assert.equal(typeof openRedis, "function");
    assert.equal(typeof closeRedis, "function");
  });
});

describe("closeRedis", () => {
  it("ignores missing or closed clients", async () => {
    await closeRedis(null);
    await closeRedis(undefined);
    await closeRedis({ isOpen: false } as unknown as OpendumRedis);
  });

  it("quits open clients", async () => {
    let quit = 0;
    await closeRedis({
      isOpen: true,
      quit: async () => {
        quit += 1;
      },
    } as unknown as OpendumRedis);
    assert.equal(quit, 1);
  });
});

