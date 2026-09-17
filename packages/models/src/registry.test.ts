import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildModelIdMap, getProviderUpstream, syncProviderModels, writeModelJson } from "./registry.ts";
import type { ModelData } from "./types.ts";

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "models-registry-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const toKey = (modelId: string) => modelId.replace(/^[^/]*\//, "").toLowerCase();

test("buildModelIdMap lets the undated rolling id own the base key", () => {
  const map = buildModelIdMap(
    ["vendor/mock-model", "vendor/mock-model-0731", "vendor/other-model"],
    toKey,
  );
  assert.equal(map.get("mock-model"), "vendor/mock-model");
  assert.equal(map.get("mock-model-0731"), "vendor/mock-model-0731");
  assert.equal(map.get("other-model"), "vendor/other-model");
});

test("buildModelIdMap makes the newest date-pinned variant win", () => {
  const map = buildModelIdMap(["x/model-0731", "x/model-0813"], toKey);
  assert.equal(map.get("model"), "x/model-0813");
  assert.equal(map.get("model-0731"), "x/model-0731");
});

test("buildModelIdMap returns keys in sorted order", () => {
  const map = buildModelIdMap(["x/zeta", "x/alpha", "x/mid"], toKey);
  assert.deepEqual([...map.keys()], ["alpha", "mid", "zeta"]);
});

test("getProviderUpstream prefers trimmed provider config upstream", () => {
  const data: ModelData = { providerConfig: { openrouter: { upstream: "  vendor/model  " } } };
  assert.equal(getProviderUpstream(data, "openrouter", "fallback"), "vendor/model");
});

test("getProviderUpstream falls back to the model id", () => {
  assert.equal(getProviderUpstream({}, "openrouter", "model-id"), "model-id");
  assert.equal(
    getProviderUpstream({ providerConfig: { openrouter: { upstream: "   " } } }, "openrouter", "model-id"),
    "model-id",
  );
});

test("writeModelJson drops family and orders keys deterministically", () => {
  withTempDir((dir) => {
    const path = join(dir, "model.json");
    writeModelJson(path, {
      id: "mock-model",
      providers: ["zeta", "opencode"],
      family: "should-be-removed",
      cost: { cacheWrite: 1, input: 2 },
    });
    const written = readFileSync(path, "utf-8");
    assert.ok(!written.includes("family"), "family field must be removed");
    assert.match(written, /"providers": \[\s*"opencode",\s*"zeta"\s*\]/);
    assert.ok(written.indexOf('"id"') < written.indexOf('"providers"'));
    assert.ok(written.indexOf('"input"') < written.indexOf('"cacheWrite"'));
    assert.ok(written.endsWith("\n"));
  });
});

test("syncProviderModels adds, updates and removes provider entries", () => {
  withTempDir((dir) => {
    const map = new Map([["mock-model", "vendor/mock-model"]]);
    const added = syncProviderModels(dir, "openrouter", map);
    assert.deepEqual(added.added, ["mock-model"]);

    const data = JSON.parse(readFileSync(join(dir, "mock-model.json"), "utf-8")) as ModelData;
    assert.deepEqual(data.providers, ["openrouter"]);
    assert.equal(data.providerConfig?.openrouter?.upstream, "vendor/mock-model");

    const unchanged = syncProviderModels(dir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    assert.deepEqual(unchanged.added, []);
    assert.deepEqual(unchanged.updated, []);

    const removed = syncProviderModels(dir, "openrouter", new Map());
    assert.deepEqual(removed.removed, ["mock-model"]);
  });
});

test("syncProviderModels adds aliases to a colliding parent", () => {
  withTempDir((dir) => {
    writeModelJson(join(dir, "base-model.json"), { id: "base-model", providers: ["openrouter"] });
    const result = syncProviderModels(dir, "openrouter", new Map([["base-model-2", "vendor/base-model-2"]]));
    const parent = JSON.parse(readFileSync(join(dir, "base-model.json"), "utf-8")) as ModelData;
    assert.deepEqual(result.added, [], "collision should merge instead of adding a new file");
    assert.ok((parent.aliases ?? []).length > 0, "parent should gain aliases");
  });
});
