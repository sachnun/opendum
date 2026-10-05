import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AuthService,
  createCustomStore,
  emptyAuthResult,
  emptyAvailability,
  isAuthlessProvider,
  isAuthlessProviderAccountId,
  parseModelParam,
} from "#auth/index.ts";

describe("auth index exports", () => {
  it("re-exports the public surface", () => {
    assert.equal(typeof AuthService, "function");
    assert.equal(typeof createCustomStore, "function");
    assert.equal(typeof emptyAuthResult, "function");
    assert.equal(typeof emptyAvailability, "function");
    assert.equal(isAuthlessProvider("opencode"), true);
    assert.equal(isAuthlessProviderAccountId("authless:kiro"), true);
    assert.deepEqual(parseModelParam("kiro/claude-x"), ["kiro", "claude-x"]);
    assert.equal(emptyAuthResult("boom").error, "boom");
    assert.deepEqual(emptyAvailability().activeProviders, new Set());
  });
});
