import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Registry } from "@opendum/models/runtime";
import { ProviderRegistry } from "#providers/registry.ts";
import { discoverProviderExtensions } from "#providers/extension/index.ts";

const EXPECTED = [
  "antigravity",
  "cline",
  "codex",
  "harbor",
  "hyper",
  "kilo_code",
  "kiro",
  "nvidia_nim",
  "opencode",
  "openrouter",
  "perch",
  "workers_ai",
  "workbuddy",
  "zenmux",
];

describe("provider registry", () => {
  it("registers every expected provider", async () => {
    const registry = new ProviderRegistry({
      models: {} as Registry,
      fallback: null,
      extensions: await discoverProviderExtensions(),
    });
    const names = registry.names();
    for (const name of EXPECTED) {
      assert.ok(names.includes(name), `missing provider: ${name}`);
    }
    assert.equal(names.length, EXPECTED.length);
  });

  it("reports credential refreshers", async () => {
    const registry = new ProviderRegistry({
      models: {} as Registry,
      fallback: null,
      extensions: await discoverProviderExtensions(),
    });
    const refreshable = registry.refreshableProviderNames();
    for (const name of ["antigravity", "cline", "codex", "kiro", "perch", "workbuddy"]) {
      assert.ok(refreshable.includes(name), `missing refresher: ${name}`);
    }
    assert.ok(!refreshable.includes("openrouter"));
    assert.ok(!refreshable.includes("opencode"));
  });
});
