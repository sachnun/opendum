import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayName, providerDisplayNames } from "#providers/model/display-names.ts";

describe("displayName", () => {
  it("maps known providers", () => {
    for (const [provider, name] of Object.entries(providerDisplayNames)) {
      assert.equal(displayName(provider), name);
    }
  });

  it("falls back to the raw provider id", () => {
    assert.equal(displayName("unknown-provider"), "unknown-provider");
  });
});
