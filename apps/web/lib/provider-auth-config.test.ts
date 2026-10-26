import { describe, expect, it } from "bun:test";

import { callbackPlaceholder, providerConfigs, providerOptions } from "~~/lib/provider-auth-config";

describe("add account dialog config", () => {
  it("exposes provider options with configs", () => {
    expect(providerOptions.length > 0).toBeTruthy();
    for (const key of providerOptions) {
      expect(providerConfigs[key], `missing config for ${key}`).toBeTruthy();
    }
  });

  it("provides a default callback placeholder", () => {
    expect(callbackPlaceholder(null)).toBe("http://localhost:1/oauth2callback?code=...");
  });
});
