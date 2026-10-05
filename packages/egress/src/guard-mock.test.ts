import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

type LookupCallback = (error: unknown, address?: unknown, family?: number) => void;

const state = {
  lookup: null as ((hostname: string, options: unknown, callback: LookupCallback) => void) | null,
  connector: null as ((options: Record<string, unknown>, callback: (error: unknown, value?: unknown) => void) => void) | null,
  agent: null as { connect: (options: Record<string, unknown>, callback: (error: unknown, value?: unknown) => void) => void } | null,
  dnsResult: null as { error?: unknown; address?: unknown; family?: number } | null,
  closed: 0,
};

mock.module("node:dns", {
  namedExports: {
    lookup: (_hostname: string, _options: unknown, callback: (error: unknown, address?: unknown, family?: number) => void) => {
      const result = state.dnsResult ?? { address: "8.8.8.8", family: 4 };
      callback(result.error ?? null, result.address, result.family);
    },
  },
});

mock.module("undici", {
  namedExports: {
    buildConnector: (options: { lookup: (hostname: string, options: unknown, callback: LookupCallback) => void }) => {
      state.lookup = options.lookup;
      const connector = (connectOptions: Record<string, unknown>, callback: (error: unknown, value?: unknown) => void) => {
        state.connector = connector as never;
        callback(null, { connectOptions });
      };
      state.connector = connector as never;
      return connector;
    },
    Agent: class {
      constructor(options: { connect: typeof state.agent }) {
        state.agent = { connect: options.connect as never };
      }
      close() {
        state.closed += 1;
        return Promise.resolve();
      }
    },
    fetch: async () => new Response("ok", { status: 200 }),
  },
});

const { createGuardedFetch } = await import("#egress/guard.ts");

createGuardedFetch({ connectTimeout: 1000 });

function lookup(hostname: string): { error: unknown; address?: unknown; family?: number } {
  let captured: { error: unknown; address?: unknown; family?: number } = { error: null };
  state.lookup!(hostname, {}, (error, address, family) => {
    captured = { error, address, family };
  });
  return captured;
}

describe("guardedLookup", () => {
  it("allows public resolutions", () => {
    state.dnsResult = { address: "8.8.8.8", family: 4 };
    const result = lookup("example.com");
    assert.equal(result.error, null);
    assert.equal(result.address, "8.8.8.8");
  });

  it("rejects private resolutions", () => {
    state.dnsResult = { address: "10.0.0.1", family: 4 };
    const result = lookup("internal.example");
    assert.ok(result.error instanceof Error);
    assert.match((result.error as Error).message, /private/);
  });

  it("checks every address in array results", () => {
    state.dnsResult = { address: [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }], family: 4 };
    assert.ok(lookup("multi.example").error instanceof Error);

    state.dnsResult = { address: [{ address: "8.8.8.8", family: 4 }, { address: "1.1.1.1", family: 4 }], family: 4 };
    assert.equal(lookup("multi.example").error, null);
  });

  it("propagates dns errors", () => {
    state.dnsResult = { error: new Error("ENOTFOUND") };
    const result = lookup("missing.example");
    assert.match((result.error as Error).message, /ENOTFOUND/);
  });
});

describe("connection guard", () => {
  it("rejects private ip literals before connecting", () => {
    let captured: unknown = null;
    state.agent!.connect({ hostname: "127.0.0.1" }, (error) => {
      captured = error;
    });
    assert.ok(captured instanceof Error);
  });

  it("delegates public hosts to the connector", () => {
    let connected = false;
    state.agent!.connect({ hostname: "8.8.8.8" }, () => {
      connected = true;
    });
    assert.equal(connected, true);
  });
});

describe("createGuardedFetch", () => {
  it("exposes fetch and close", async () => {
    const guard = createGuardedFetch({ headersTimeout: 1000, connectTimeout: 1000 });
    const response = await guard.fetch("https://example.com");
    assert.equal(response.status, 200);
    await guard.close();
    assert.equal(state.closed >= 1, true);
  });
});
