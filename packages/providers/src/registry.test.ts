import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import {
  ProviderRegistry,
  isAuthlessProvider,
  isCredentialRefresher,
} from "#providers/registry.ts";
import type { ProviderExtension } from "#providers/extension/types.ts";
import type { Provider } from "#providers/model/types.ts";

function base(name: string): Provider {
  return { name, makeRequest: async () => new Response("{}") };
}

const extensions: ProviderExtension[] = [
  { name: "alpha", order: 1, create: () => ({ ...base("alpha"), authless: () => true }) },
  {
    name: "beta",
    order: 2,
    create: () => ({
      ...base("beta"),
      refreshCredentials: async () => ({ accessToken: "a", refreshToken: "r", expiresAt: new Date() }),
    }),
  },
];

function registry(): ProviderRegistry {
  return new ProviderRegistry({
    models: {} as Registry,
    fallback: null,
    directFetch: async () => new Response("{}"),
    extensions,
  });
}

describe("ProviderRegistry", () => {
  it("registers extension providers", () => {
    const reg = registry();
    assert.deepEqual(reg.names(), ["alpha", "beta"]);
    assert.equal(reg.has("alpha"), true);
    assert.equal(reg.has("missing"), false);
    assert.equal(reg.get("beta")?.name, "beta");
    assert.equal(reg.get("missing"), undefined);
  });

  it("detects authless and refreshable providers", () => {
    const reg = registry();
    assert.equal(reg.isAuthless("alpha"), true);
    assert.equal(reg.isAuthless("beta"), false);
    assert.equal(reg.isAuthless("missing"), false);
    assert.deepEqual(reg.refreshableProviderNames(), ["beta"]);
  });

  it("tracks egress readiness", () => {
    const reg = registry();
    assert.equal(reg.egressReady(), false);
    reg.setEgress(async () => new Response("{}"), true);
    assert.equal(reg.egressReady(), true);
  });

  it("exposes transport helpers", () => {
    assert.equal(isAuthlessProvider({ ...base("x"), authless: () => false } as unknown as Provider), true);
    assert.equal(isAuthlessProvider(base("x")), false);
    assert.equal(isCredentialRefresher(base("x")), false);
    assert.equal(
      isCredentialRefresher({
        ...base("x"),
        refreshCredentials: async () => ({ accessToken: "", refreshToken: "", expiresAt: new Date() }),
      } as unknown as Provider),
      true
    );
  });
});
