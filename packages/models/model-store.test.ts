import { expect, test } from "bun:test";

import { idMap, buildIndex, upstream, prune, moveFiles, sync, writeGenerated, write } from "./model-store.ts";
import { readText } from "./fs.ts";
import { join } from "./paths.ts";
import { makeDir, removeDir } from "./test-support.ts";
import type { ModelData } from "./types.ts";

async function tempWorkspace<A>(run: (dataDir: string, generatedDir: string) => A | Promise<A>): Promise<A> {
  const root = makeDir("models-registry-");
  const dataDir = join(root, "data");
  const generatedDir = join(root, "generated");
  try {
    return await run(dataDir, generatedDir);
  } finally {
    removeDir(root);
  }
}

const toKey = (modelId: string) => modelId.replace(/^[^/]*\//, "").toLowerCase();

test("idMap lets the undated rolling id own the base key", () => {
  const map = idMap(
    ["vendor/mock-model", "vendor/mock-model-0731", "vendor/other-model"],
    toKey,
  );
  expect(map.get("mock-model")).toBe("vendor/mock-model");
  expect(map.get("mock-model-0731")).toBe("vendor/mock-model-0731");
  expect(map.get("other-model")).toBe("vendor/other-model");
});

test("idMap makes the newest date-pinned variant win", () => {
  const map = idMap(["x/model-0731", "x/model-0813"], toKey);
  expect(map.get("model")).toBe("x/model-0813");
  expect(map.get("model-0731")).toBe("x/model-0731");
});

test("idMap returns keys in sorted order", () => {
  const map = idMap(["x/zeta", "x/alpha", "x/mid"], toKey);
  expect([...map.keys()]).toEqual(["alpha", "mid", "zeta"]);
});

test("upstream prefers trimmed provider config upstream", () => {
  const data: ModelData = { providerConfig: { openrouter: { upstream: "  vendor/model  " } } };
  expect(upstream(data, "openrouter", "fallback")).toBe("vendor/model");
});

test("upstream falls back to the model id", () => {
  expect(upstream({}, "openrouter", "model-id")).toBe("model-id");
  expect(upstream({ providerConfig: { openrouter: { upstream: "   " } } }, "openrouter", "model-id")).toBe("model-id");
});

test("write drops family and orders keys deterministically", async () => {
  await tempWorkspace(async (dataDir) => {
    const path = join(dataDir, "model.json");
    await write(path, {
      id: "mock-model",
      providers: ["zeta", "opencode"],
      family: "should-be-removed",
      cost: { cacheWrite: 1, input: 2 },
    });
    const written = readText(path);
    expect(!written.includes("family")).toBeTruthy();
    expect(written).toMatch(/"providers": \[\s*"zeta",\s*"opencode"\s*\]/);
    expect(written.indexOf('"id"') < written.indexOf('"providers"')).toBeTruthy();
    expect(written.indexOf('"input"') < written.indexOf('"cacheWrite"')).toBeTruthy();
    expect(written.endsWith("\n")).toBeTruthy();
  });
});

function mergedData(dataDir: string, relativeId: string): ModelData {
  const entry = buildIndex(dataDir)[relativeId];
  expect(entry, `missing model ${relativeId}`).toBeTruthy();
  return entry.data;
}

test("sync adds, updates and removes provider entries", async () => {
  await tempWorkspace(async (dataDir) => {
    const map = new Map([["mock-model", "vendor/mock-model"]]);
    const added = await sync(dataDir, "openrouter", map);
    expect(added.added).toEqual(["mock-model"]);

    const data = mergedData(dataDir, "mock-model");
    expect(data.providers).toEqual(["openrouter"]);
    expect(data.providerConfig?.openrouter?.upstream).toBe("vendor/mock-model");

    const unchanged = await sync(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    expect(unchanged.added).toEqual([]);
    expect(unchanged.updated).toEqual([]);

    const removed = await sync(dataDir, "openrouter", new Map());
    expect(removed.removed).toEqual(["mock-model"]);
  });
});

test("sync writes derived fields to generated only", async () => {
  await tempWorkspace(async (dataDir, generatedDir) => {
    await sync(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    const generated = JSON.parse(readText(join(generatedDir, "mock-model.json"))) as ModelData;
    expect(generated.providers).toEqual(["openrouter"]);
    expect(generated.providerConfig?.openrouter?.upstream).toBe("vendor/mock-model");
  });
});

test("renameFiles moves both halves and keeps the folder", async () => {
  await tempWorkspace(async (dataDir, generatedDir) => {
    await writeGenerated(join(generatedDir, "gemma-3.json"), { providers: ["openrouter"] });
    await write(join(dataDir, "gemma-3.json"), { ignored: true });

    const next = await moveFiles({ modelsDir: dataDir, generatedDir, relativeId: "gemma-3" }, "gemma-3-12b-it");
    expect(next).toBe("gemma-3-12b-it");
    expect(() => readText(join(generatedDir, "gemma-3.json"))).toThrow();
    expect(() => readText(join(dataDir, "gemma-3.json"))).toThrow();
    expect(JSON.parse(readText(join(generatedDir, "gemma-3-12b-it.json"))).providers).toEqual(["openrouter"]);
    expect(JSON.parse(readText(join(dataDir, "gemma-3-12b-it.json")))).toEqual({ ignored: true });
  });
});

test("renameFiles keeps the folder and refuses to clobber", async () => {
  await tempWorkspace(async (dataDir, generatedDir) => {
    await writeGenerated(join(generatedDir, "vendor/old.json"), { providers: ["openrouter"] });
    await writeGenerated(join(generatedDir, "vendor/new.json"), { providers: ["kiro"] });

    const next = await moveFiles({ modelsDir: dataDir, generatedDir, relativeId: "vendor/old" }, "new");
    expect(next).toBe("vendor/old");
    expect(JSON.parse(readText(join(generatedDir, "vendor/new.json"))).providers).toEqual(["kiro"]);

    const moved = await moveFiles({ modelsDir: dataDir, generatedDir, relativeId: "vendor/old" }, "renamed");
    expect(moved).toBe("vendor/renamed");
  });
});

test("buildIndex needs the generated half to expose providers", async () => {
  await tempWorkspace(async (dataDir, generatedDir) => {
    await sync(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    expect(buildIndex(dataDir)["mock-model"].data.providers).toEqual(["openrouter"]);

    const authoredOnly = buildIndex(dataDir, { generatedDir: join(generatedDir, "absent") });
    expect(authoredOnly["mock-model"]).toBeUndefined();
  });
});

test("prune drops uncurated dead entries and keeps the rest", async () => {
  await tempWorkspace(async (dataDir, generatedDir) => {
    await writeGenerated(join(generatedDir, "dead.json"), { providers: [] });
    await writeGenerated(join(generatedDir, "live.json"), { providers: ["openrouter"] });
    await write(join(dataDir, "ignored-dead.json"), { ignored: true });
    await write(join(dataDir, "curated-dead.json"), {
      ignored: true,
      providerConfig: { example: { agent: "base2-free" } },
    });

    expect(await prune(dataDir)).toEqual(["dead", "ignored-dead"]);

    const index = buildIndex(dataDir);
    expect(index["dead"]).toBeUndefined();
    expect(index["ignored-dead"]).toBeUndefined();
    expect(index["live"]).toBeTruthy();
    expect(index["curated-dead"]).toBeTruthy();
  });
});

test("sync removes the file once the last provider leaves", async () => {
  await tempWorkspace(async (dataDir, generatedDir) => {
    await sync(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    await sync(dataDir, "openrouter", new Map());
    expect(buildIndex(dataDir)["mock-model"]).toBeUndefined();
    expect(() => readText(join(generatedDir, "mock-model.json"))).toThrow();
  });
});

test("sync adds aliases to a colliding parent", async () => {
  await tempWorkspace(async (dataDir) => {
    await sync(dataDir, "openrouter", new Map([["base-model", "vendor/base-model"]]));
    const result = await sync(dataDir, "openrouter", new Map([["base-model-2", "vendor/base-model-2"]]));
    const parent = Object.values(buildIndex(dataDir)).find((entry) => entry.id === "base-model");
    expect(parent).toBeTruthy();
    if (!parent) return;
    expect(result.added).toEqual([]);
    expect((parent.data.aliases ?? []).length > 0).toBeTruthy();
  });
});

test("sync keeps minor versions as separate models", async () => {
  await tempWorkspace(async (dataDir) => {
    await sync(dataDir, "kiro", new Map([["claude-opus-5", "claude-opus-5"]]));
    const result = await sync(dataDir, "antigravity", new Map([["claude-opus-5-5", "claude-opus-5-5-medium"]]));

    expect(result.added).toEqual(["claude-opus-5-5"]);
    expect(mergedData(dataDir, "anthropic/claude-opus-5").providers).toEqual(["kiro"]);

    const newer = mergedData(dataDir, "anthropic/claude-opus-5-5");
    expect(newer.providers).toEqual(["antigravity"]);
    expect(newer.providerConfig?.antigravity?.upstream).toBe("claude-opus-5-5-medium");
  });
});

test("sync still folds real revision suffixes into the parent", async () => {
  await tempWorkspace(async (dataDir) => {
    await sync(dataDir, "openrouter", new Map([["mock-model", "vendor/mock-model"]]));
    const result = await sync(dataDir, "openrouter", new Map([["mock-model-2", "vendor/mock-model-2"]]));
    expect(result.added).toEqual([]);
  });
});
