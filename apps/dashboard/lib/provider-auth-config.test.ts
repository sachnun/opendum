import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { callbackPlaceholder, providerConfigs, providerOptions } from "./provider-auth-config";

describe("add account dialog config", () => {
  it("exposes provider options with configs", () => {
    assert.ok(providerOptions.length > 0);
    for (const key of providerOptions) {
      assert.ok(providerConfigs[key], `missing config for ${key}`);
    }
  });

  it("provides a default callback placeholder", () => {
    assert.equal(callbackPlaceholder(null), "http://localhost:1/oauth2callback?code=...");
  });
});
