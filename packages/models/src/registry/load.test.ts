import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadModelEntries } from "#models/registry/load.ts";

function workspace(): { authored: string; generated: string } {
  const root = mkdtempSync(join(tmpdir(), "opendum-load-"));
  const authored = join(root, "data");
  const generated = join(root, "generated");
  mkdirSync(authored, { recursive: true });
  mkdirSync(generated, { recursive: true });
  return { authored, generated };
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), JSON.stringify(value));
}

describe("loadModelEntries error paths", () => {
  it("throws when the models directory is missing", () => {
    assert.throws(() => loadModelEntries(join(tmpdir(), "opendum-missing-models-dir")), /models directory not found/);
  });

  it("throws when the models path is not a directory", () => {
    const root = mkdtempSync(join(tmpdir(), "opendum-load-file-"));
    const file = join(root, "data");
    writeFileSync(file, "not a directory");
    assert.throws(() => loadModelEntries(file), /models path is not a directory/);
  });
});

const originalGeneratedDir = process.env.MODELS_GENERATED_DIR;

afterEach(() => {
  if (originalGeneratedDir === undefined) delete process.env.MODELS_GENERATED_DIR;
  else process.env.MODELS_GENERATED_DIR = originalGeneratedDir;
});

describe("loadModelEntries", () => {
  it("collects authored entries recursively with owners", () => {
    const { authored } = workspace();
    writeJson(authored, "muse.json", { id: "muse", providers: ["opencode"] });
    mkdirSync(join(authored, "anthropic"), { recursive: true });
    writeJson(join(authored, "anthropic"), "claude.json", { id: "claude", providers: ["antigravity"] });

    const entries = loadModelEntries(authored);
    assert.equal(entries.length, 2);
    const byId = new Map(entries.map((entry) => [entry.fileId, entry]));
    assert.equal(byId.get("muse")?.owner, "");
    assert.equal(byId.get("claude")?.owner, "anthropic");
  });

  it("merges generated info into the authored entry", () => {
    const { authored, generated } = workspace();
    writeJson(authored, "muse.json", {
      id: "muse",
      providers: [],
      aliases: ["muse-alias"],
      providerConfig: { opencode: { responses_api: true } },
    });
    writeJson(generated, "muse.json", {
      id: "muse",
      providers: ["opencode"],
      aliases: ["generated-alias"],
      reasoning: true,
      providerConfig: {
        opencode: { upstream: "muse-free", contextWindow: 1000, maxOutputTokens: 100 },
      },
    });

    const entries = loadModelEntries(authored);
    assert.equal(entries.length, 1);
    const info = entries[0]!.info;
    assert.deepEqual(info.providers, ["opencode"]);
    assert.deepEqual(info.aliases, ["muse-alias", "generated-alias"]);
    assert.equal(info.reasoning, true);
    const config = info.providerConfig?.opencode as Record<string, unknown>;
    assert.equal(config.upstream, "muse-free");
    assert.equal(config.contextWindow, 1000);
    assert.equal((config.custom as Record<string, unknown>).responses_api, true);
  });

  it("prefers authored values over generated ones", () => {
    const { authored, generated } = workspace();
    writeJson(authored, "muse.json", {
      id: "muse",
      providers: ["opencode"],
      providerConfig: { opencode: { upstream: "authored", maxOutputTokens: 42 } },
    });
    writeJson(generated, "muse.json", {
      id: "muse",
      providers: ["opencode"],
      providerConfig: { opencode: { upstream: "generated", maxOutputTokens: 100, contextWindow: 1000 } },
    });

    const config = loadModelEntries(authored)[0]!.info.providerConfig?.opencode as Record<string, unknown>;
    assert.equal(config.upstream, "authored");
    assert.equal(config.maxOutputTokens, 42);
    assert.equal(config.contextWindow, 1000);
  });

  it("appends generated-only entries", () => {
    const { authored, generated } = workspace();
    writeJson(authored, "muse.json", { id: "muse", providers: ["opencode"] });
    writeJson(generated, "extra.json", { id: "extra", providers: ["opencode"] });

    const ids = loadModelEntries(authored).map((entry) => entry.fileId);
    assert.deepEqual(ids, ["muse", "extra"]);
  });

  it("throws when the authored directory is missing", () => {
    assert.throws(() => loadModelEntries(join(tmpdir(), `opendum-missing-${Date.now()}-${Math.random()}`)), /not found/);
  });

  it("honours MODELS_GENERATED_DIR", () => {
    const { authored } = workspace();
    const override = mkdtempSync(join(tmpdir(), "opendum-generated-"));
    writeJson(authored, "muse.json", { id: "muse", providers: [] });
    writeJson(override, "muse.json", { id: "muse", providers: ["opencode"] });
    process.env.MODELS_GENERATED_DIR = override;

    assert.deepEqual(loadModelEntries(authored)[0]!.info.providers, ["opencode"]);
  });
});
