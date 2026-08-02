// Determinism + dry-run tests for the shared model registry sync layer.
//
// Run: node --test scripts/lib/
//
// Coverage:
//   * buildModelIndex returns files in sorted order (readdir order is
//     filesystem-dependent and would otherwise make collision resolution and
//     removed-list ordering nondeterministic).
//   * syncProviderModels with dryRun=true reports the same result as a real
//     run but writes nothing.
//   * syncProviderModels is idempotent: a second real run reports no changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildModelIndex, syncProviderModels } from "../model-registry.mjs";

function makeFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "opendum-registry-"));
  mkdirSync(join(dir, "google"));
  mkdirSync(join(dir, "openai"));
  // Insertion order deliberately non-alphabetical.
  writeFileSync(join(dir, "openai", "zebra.json"), JSON.stringify({ providers: ["other"] }));
  writeFileSync(join(dir, "google", "alpha.json"), JSON.stringify({ providers: ["other"] }));
  writeFileSync(join(dir, "google", "bravo.json"), JSON.stringify({ providers: ["other"] }));
  return dir;
}

function listJsonFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (entry.endsWith(".json")) {
      out.push(full);
    } else {
      out.push(...listJsonFiles(full));
    }
  }
  return out;
}

test("buildModelIndex yields sorted file order", () => {
  const dir = makeFixtureDir();
  try {
    const index = buildModelIndex(dir);
    assert.deepEqual(Object.keys(index), ["alpha", "bravo", "zebra"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncProviderModels dryRun writes nothing but reports the same changes", () => {
  const dir = makeFixtureDir();
  try {
    const modelMap = new Map([
      ["beta-2", "beta-2-upstream"],
      ["gamma", "gamma-upstream"],
    ]);

    const dry = syncProviderModels(dir, "test_provider", new Map(modelMap), { dryRun: true });

    // Nothing written: no new files, no modified existing files.
    assert.deepEqual(listJsonFiles(dir), [
      join(dir, "google", "alpha.json"),
      join(dir, "google", "bravo.json"),
      join(dir, "openai", "zebra.json"),
    ]);
    assert.deepEqual(readFileSync(join(dir, "google", "alpha.json"), "utf-8"), JSON.stringify({ providers: ["other"] }));

    const real = syncProviderModels(dir, "test_provider", modelMap);

    assert.deepEqual(real.added, dry.added);
    assert.deepEqual(real.removed, dry.removed);
    assert.deepEqual(real.updated, dry.updated);
    assert.deepEqual(real.added, ["beta-2", "gamma"]);

    // New files exist after the real run.
    assert.ok(existsSync(join(dir, "beta-2.json")));
    assert.ok(existsSync(join(dir, "gamma.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncProviderModels is idempotent (second run reports no changes)", () => {
  const dir = makeFixtureDir();
  try {
    const modelMap = new Map([["gamma", "gamma-upstream"]]);
    syncProviderModels(dir, "test_provider", modelMap);

    const second = syncProviderModels(dir, "test_provider", modelMap);
    assert.deepEqual(second, { added: [], removed: [], updated: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncProviderModels returns sorted result arrays", () => {
  const dir = makeFixtureDir();
  try {
    const modelMap = new Map([
      // "alpha-2" collides with the existing alpha.json (versioned-suffix
      // parent merge) -> becomes an alias update, not an add.
      ["alpha-2", "alpha-2-upstream"],
      ["zeta", "zeta-upstream"],
    ]);
    const result = syncProviderModels(dir, "test_provider", modelMap, { dryRun: true });
    assert.deepEqual(result.added, ["zeta"]);
    assert.deepEqual(result.updated, ["alpha"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
