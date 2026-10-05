import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverProviderExtensions } from "#providers/extension/index.ts";

test("discovers provider extensions from folders", async () => {
  const extensions = await discoverProviderExtensions();
  const names = extensions.map((extension) => extension.name);

  assert.ok(names.includes("workers_ai"), `expected workers_ai, got ${names.join(", ")}`);
  assert.equal(new Set(names).size, names.length, "extension names must be unique");
  for (const extension of extensions) {
    assert.equal(typeof extension.create, "function", `${extension.name} must expose create()`);
  }
});
