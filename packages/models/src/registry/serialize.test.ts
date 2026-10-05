import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readModelJson, writeGeneratedModelJson, writeModelJson } from "#models/registry/serialize.ts";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "opendum-serialize-")), name);
}

describe("readModelJson", () => {
  it("parses json content", () => {
    assert.deepEqual(readModelJson('{"id":"m","providers":["opencode"]}'), {
      id: "m",
      providers: ["opencode"],
    });
  });
});

describe("writeModelJson ordering", () => {
  it("orders top-level keys, sorts aliases and drops family", () => {
    const path = tempFile("m.json");
    writeModelJson(path, {
      providers: ["b", "a"],
      family: "should-be-removed",
      aliases: ["z", "a"],
      id: "m",
      description: "d",
      cost: { output: 2, input: 1, cacheWrite: 4, cacheRead: 3 },
      modalities: { input: ["text", "image"], output: ["text"] },
      providerConfig: {
        zzz: { upstream: "u", extra: true, maxOutputTokens: 5 },
        aaa: { contextWindow: 10 },
      },
      scores: { artificialAnalysis: { version: "1", index: 2, estimated: true } },
    });

    const raw = readFileSync(path, "utf8");
    assert.ok(raw.endsWith("\n"));
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed), [
      "id",
      "providers",
      "aliases",
      "description",
      "modalities",
      "cost",
      "scores",
      "providerConfig",
    ]);
    assert.equal("family" in parsed, false);
    assert.deepEqual(parsed.aliases, ["a", "z"]);
    assert.deepEqual(Object.keys(parsed.cost as object), ["input", "output", "cacheRead", "cacheWrite"]);
    assert.deepEqual(Object.keys(parsed.providerConfig as object), ["aaa", "zzz"]);
    assert.deepEqual(Object.keys((parsed.providerConfig as Record<string, object>).zzz), ["upstream", "maxOutputTokens", "extra"]);
    assert.deepEqual(Object.keys((parsed.scores as Record<string, object>).artificialAnalysis), ["index", "estimated", "version"]);
  });
});

describe("writeGeneratedModelJson", () => {
  it("creates parent directories", () => {
    const path = join(mkdtempSync(join(tmpdir(), "opendum-serialize-")), "nested", "deep", "m.json");
    writeGeneratedModelJson(path, { providers: ["opencode"] });
    assert.deepEqual(readModelJson(readFileSync(path, "utf8")), { providers: ["opencode"] });
  });
});
