import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverQuotaProviders } from "./extension.js";

test("discovers quota providers from folders", async () => {
  const providers = await discoverQuotaProviders();
  const names = providers.map((provider) => provider.name).sort();

  assert.deepEqual(names, [
    "antigravity",
    "codex",
    "hyper",
    "kiro",
    "openrouter",
    "perch",
    "workbuddy",
    "zenmux",
  ]);
  for (const provider of providers) {
    assert.equal(typeof provider.fetch, "function", `${provider.name} must expose fetch()`);
  }
});
