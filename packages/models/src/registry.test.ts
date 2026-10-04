import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildModelIdMap, buildModelIndex, getProviderUpstream, pruneDeadModelEntries, renameModelFiles, syncProviderModels, writeGeneratedModelJson, writeModelJson } from "./registry.ts";
import type { ModelData } from "./types.ts";

function withTempDir<T>(run: (dataDir: string, generatedDir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "models-registry-"));
  const dataDir = join(root, "data");
  const generatedDir = join(root, "generated");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  try {
    return run(dataDir, generatedDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
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
  withTempDir((dataDir) => {
    const path = join(dataDir, "model.json");
    writeModelJson(path, {
      id: "mock-model",
      providers: ["zeta", "opencode"],
      family: "should-be-removed",
      cost: { cacheWrite: 1, input: 2 },
    });
    const written = readFileSync(path, "utf-8");
    assert.ok(!written.includes("family"), "family field must be removed");
    assert.match(written, /"providers": \[\s*"zeta",\s*"opencode"\s*\]/);
    assert.ok(written.indexOf('"id"') < written.indexOf('"providers"'));
    assert.ok(written.indexOf('"input"') < written.indexOf('"cacheWrite"'));
    assert.ok(written.endsWith("\n"));
  });
});

function mergedData(dataDir: string, relativeId: string): ModelData {
  const entry = buildModelIndex(dataDir)[relativeId];
  assert.ok(entry, `missing model ${relativeId}`);
  return entry.data;
}

test("syncProviderModels adds, updates and removes provider entries", () => {
  withTempDir((dataDir) => {
    const map = new Map([["mock-model", "vendor/mock-model"]]);
    const added = syncProviderModels(dataDir, "openrouter", map);
    assert.deepEqual(added.added, ["mock-model"]);

    const data = mergedData(dataDir, "mock-model");
    assert.deepEqual(data.providers, ["openrouter"]);
    assert.equal(data.providerConfig?.openrouter?.upstream, "vendor/mock-model");

    const unchanged = syncProviderModels(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    assert.deepEqual(unchanged.added, []);
    assert.deepEqual(unchanged.updated, []);

    const removed = syncProviderModels(dataDir, "openrouter", new Map());
    assert.deepEqual(removed.removed, ["mock-model"]);
  });
});

test("syncProviderModels writes derived fields to generated only", () => {
  withTempDir((dataDir, generatedDir) => {
    syncProviderModels(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    const generated = JSON.parse(readFileSync(join(generatedDir, "mock-model.json"), "utf-8")) as ModelData;
    assert.deepEqual(generated.providers, ["openrouter"]);
    assert.equal(generated.providerConfig?.openrouter?.upstream, "vendor/mock-model");
  });
});

test("renameModelFiles moves both halves and keeps the folder", () => {
  withTempDir((dataDir, generatedDir) => {
    writeGeneratedModelJson(join(generatedDir, "gemma-3.json"), { providers: ["openrouter"] });
    writeModelJson(join(dataDir, "gemma-3.json"), { ignored: true });

    const next = renameModelFiles({ modelsDir: dataDir, generatedDir, relativeId: "gemma-3" }, "gemma-3-12b-it");
    assert.equal(next, "gemma-3-12b-it");
    assert.throws(() => readFileSync(join(generatedDir, "gemma-3.json")));
    assert.throws(() => readFileSync(join(dataDir, "gemma-3.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(generatedDir, "gemma-3-12b-it.json"), "utf-8")).providers, ["openrouter"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "gemma-3-12b-it.json"), "utf-8")), { ignored: true });
  });
});

test("renameModelFiles keeps the folder and refuses to clobber", () => {
  withTempDir((dataDir, generatedDir) => {
    writeGeneratedModelJson(join(generatedDir, "vendor/old.json"), { providers: ["openrouter"] });
    writeGeneratedModelJson(join(generatedDir, "vendor/new.json"), { providers: ["kiro"] });

    const next = renameModelFiles({ modelsDir: dataDir, generatedDir, relativeId: "vendor/old" }, "new");
    assert.equal(next, "vendor/old");
    assert.deepEqual(JSON.parse(readFileSync(join(generatedDir, "vendor/new.json"), "utf-8")).providers, ["kiro"]);

    const moved = renameModelFiles({ modelsDir: dataDir, generatedDir, relativeId: "vendor/old" }, "renamed");
    assert.equal(moved, "vendor/renamed");
  });
});

test("buildModelIndex needs the generated half to expose providers", () => {
  withTempDir((dataDir, generatedDir) => {
    syncProviderModels(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    assert.deepEqual(buildModelIndex(dataDir)["mock-model"].data.providers, ["openrouter"]);

    const authoredOnly = buildModelIndex(dataDir, { generatedDir: join(generatedDir, "absent") });
    assert.equal(authoredOnly["mock-model"], undefined);
  });
});

test("pruneDeadModelEntries drops uncurated dead entries and keeps the rest", () => {
  withTempDir((dataDir, generatedDir) => {
    writeGeneratedModelJson(join(generatedDir, "dead.json"), { providers: [] });
    writeGeneratedModelJson(join(generatedDir, "live.json"), { providers: ["openrouter"] });
    writeModelJson(join(dataDir, "ignored-dead.json"), { ignored: true });
    writeModelJson(join(dataDir, "curated-dead.json"), {
      ignored: true,
      providerConfig: { example: { agent: "base2-free" } },
    });

    assert.deepEqual(pruneDeadModelEntries(dataDir), ["dead", "ignored-dead"]);

    const index = buildModelIndex(dataDir);
    assert.equal(index["dead"], undefined);
    assert.equal(index["ignored-dead"], undefined);
    assert.ok(index["live"]);
    assert.ok(index["curated-dead"]);
  });
});

test("syncProviderModels removes the file once the last provider leaves", () => {
  withTempDir((dataDir, generatedDir) => {
    syncProviderModels(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    syncProviderModels(dataDir, "openrouter", new Map());
    assert.equal(buildModelIndex(dataDir)["mock-model"], undefined);
    assert.throws(() => readFileSync(join(generatedDir, "mock-model.json")));
  });
});

test("syncProviderModels adds aliases to a colliding parent", () => {
  withTempDir((dataDir) => {
    syncProviderModels(dataDir, "openrouter", new Map([["base-model", "vendor/base-model"]]));
    const result = syncProviderModels(dataDir, "openrouter", new Map([["base-model-2", "vendor/base-model-2"]]));
    const parent = Object.values(buildModelIndex(dataDir)).find((entry) => entry.id === "base-model");
    assert.ok(parent, "parent model must exist");
    assert.deepEqual(result.added, [], "collision should merge instead of adding a new file");
    assert.ok((parent.data.aliases ?? []).length > 0, "parent should gain aliases");
  });
});

test("syncProviderModels keeps minor versions as separate models", () => {
  withTempDir((dataDir) => {
    syncProviderModels(dataDir, "kiro", new Map([["claude-opus-5", "claude-opus-5"]]));
    const result = syncProviderModels(dataDir, "antigravity", new Map([["claude-opus-5-5", "claude-opus-5-5-medium"]]));

    assert.deepEqual(result.added, ["claude-opus-5-5"]);
    assert.deepEqual(mergedData(dataDir, "anthropic/claude-opus-5").providers, ["kiro"], "base model must stay untouched");

    const newer = mergedData(dataDir, "anthropic/claude-opus-5-5");
    assert.deepEqual(newer.providers, ["antigravity"]);
    assert.equal(newer.providerConfig?.antigravity?.upstream, "claude-opus-5-5-medium");
  });
});

test("syncProviderModels still folds real revision suffixes into the parent", () => {
  withTempDir((dataDir) => {
    syncProviderModels(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    const result = syncProviderModels(dataDir, "openrouter", new Map([["mock-model-2", "vendor/mock-model-2"]]));
    assert.deepEqual(result.added, [], "revision suffix should merge into the parent");
  });
});
