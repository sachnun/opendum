import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

const state = { connect: 0, ping: 0, error: null as Error | null };

mock.module("redis", {
  namedExports: {
    createClient: () => ({
      isOpen: false,
      on: (event: string, handler: (error: Error) => void) => {
        if (state.error) handler(state.error);
      },
      connect: async () => {
        state.connect += 1;
      },
      ping: async () => {
        state.ping += 1;
        return "PONG";
      },
    }),
  },
});

const { openRedis } = await import("#redis/client.ts");

describe("openRedis", () => {
  it("connects and pings", async () => {
    const client = await openRedis("redis://cache");
    assert.equal(state.connect, 1);
    assert.equal(state.ping, 1);
    assert.ok(client);
  });

  it("registers an error handler", async () => {
    state.error = new Error("boom");
    await openRedis("redis://cache");
    state.error = null;
    assert.equal(state.connect, 2);
  });
});
