import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchAccountQuota,
  isQuotaProvider,
  quotaProvidersWithoutToken,
  registerQuotaProviders,
} from "#quota/registry.ts";
import type { AccountQuotaInfo, QuotaAccount, QuotaContext, QuotaProvider } from "#quota/types.ts";

function account(overrides: Partial<QuotaAccount> = {}): QuotaAccount {
  return { id: "a1", userId: "u1", provider: "test-a", ...overrides };
}

function context(overrides: Partial<QuotaContext> = {}): QuotaContext {
  return {
    fetch: async () => new Response("{}", { status: 200 }),
    journal: null,
    decrypt: (value) => value,
    getCredentials: async () => "creds",
    ...overrides,
  };
}

function info(status: string): AccountQuotaInfo {
  return { status, error: "", groups: [] };
}

describe("quota provider registry", () => {
  it("registers providers and reports membership", () => {
    registerQuotaProviders([{ name: "reg-a", fetch: async () => info("ok") }]);
    assert.equal(isQuotaProvider("reg-a"), true);
    assert.equal(isQuotaProvider("nope"), false);
  });

  it("collects providers that do not need a token", () => {
    registerQuotaProviders([
      { name: "reg-tokenless", needsToken: false, fetch: async () => info("ok") },
      { name: "reg-tokened", fetch: async () => info("ok") },
    ]);
    const withoutToken = quotaProvidersWithoutToken();
    assert.equal(withoutToken.has("reg-tokenless"), true);
    assert.equal(withoutToken.has("reg-tokened"), false);
  });
});

describe("fetchAccountQuota", () => {
  it("errors for an unregistered provider", async () => {
    const result = await fetchAccountQuota(context(), account({ provider: "missing-provider" }), false);
    assert.equal(result.status, "error");
    assert.match(result.error, /not supported/);
  });

  it("skips credential lookup for tokenless providers", async () => {
    let received = "unset";
    const provider: QuotaProvider = {
      name: "fetch-tokenless",
      needsToken: false,
      fetch: async (_ctx, _account, token) => {
        received = token;
        return info("active");
      },
    };
    registerQuotaProviders([provider]);
    const result = await fetchAccountQuota(
      context({ getCredentials: async () => { throw new Error("should not be called"); } }),
      account({ provider: "fetch-tokenless" }),
      true
    );
    assert.equal(received, "");
    assert.equal(result.status, "active");
  });

  it("passes resolved credentials to the provider", async () => {
    let received = "";
    registerQuotaProviders([
      {
        name: "fetch-tokened",
        fetch: async (_ctx, _account, token) => {
          received = token;
          return info("active");
        },
      },
    ]);
    const result = await fetchAccountQuota(context({ getCredentials: async () => "token-123" }), account({ provider: "fetch-tokened" }), false);
    assert.equal(received, "token-123");
    assert.equal(result.status, "active");
  });

  it("reports an expired account when credentials fail", async () => {
    registerQuotaProviders([
      { name: "fetch-expired", fetch: async () => info("active") },
    ]);
    const result = await fetchAccountQuota(
      context({ getCredentials: async () => { throw new Error("expired"); } }),
      account({ provider: "fetch-expired" }),
      false
    );
    assert.equal(result.status, "expired");
    assert.match(result.error, /Token expired/);
  });
});
