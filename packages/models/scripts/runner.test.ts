import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverSources, orderSources } from "./runner.ts";

const EXPECTED = [
  "aa",
  "antigravity",
  "cline",
  "cloudflare",
  "codex",
  "enrich",
  "harbor",
  "hyper",
  "kilo-code",
  "kiro",
  "nvidia",
  "opencode",
  "openrouter",
  "perch",
  "workbuddy",
  "zenmux",
];

test("discovers model sources from scripts", async () => {
  const sources = await discoverSources();
  assert.deepEqual(sources.map((source) => source.name).sort(), EXPECTED);
  for (const source of sources) {
    assert.equal(typeof source.run, "function", `${source.name} must expose run()`);
  }
});

test("orders tail sources last", async () => {
  const ordered = orderSources(await discoverSources()).map((source) => source.name);
  assert.deepEqual([...ordered.slice(-2)].sort(), ["aa", "enrich"]);
});
