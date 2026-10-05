import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { discoverModules } from "#extension/index.ts";

function fixture(files: Record<string, string>): URL {
  const dir = mkdtempSync(join(tmpdir(), "opendum-extension-"));
  for (const [relative, content] of Object.entries(files)) {
    const target = join(dir, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return pathToFileURL(`${dir}/`);
}

test("discovers descriptor exports from matching files", async () => {
  const dir = fixture({
    "alpha/index.js": "export const extension = { name: 'alpha' };",
    "beta/index.js": "export const extension = { name: 'beta' };",
  });
  const found = await discoverModules({ pattern: "*/index.js", dir });
  assert.deepEqual(found.map((item) => item.name), ["alpha", "beta"]);
});

test("rejects a matching file without the descriptor export", async () => {
  const dir = fixture({ "alpha/index.js": "export const other = 1;" });
  await assert.rejects(() => discoverModules({ pattern: "*/index.js", dir }), /has no "extension" export/);
});

test("rejects duplicate names", async () => {
  const dir = fixture({
    "a/index.js": "export const extension = { name: 'same' };",
    "b/index.js": "export const extension = { name: 'same' };",
  });
  await assert.rejects(() => discoverModules({ pattern: "*/index.js", dir }), /duplicate name "same"/);
});

test("honors the filter predicate", async () => {
  const dir = fixture({
    "keep/index.js": "export const extension = { name: 'keep' };",
    "skip/index.js": "export const extension = { name: 'skip' };",
  });
  const found = await discoverModules({
    pattern: "*/index.js",
    dir,
    filter: (file) => !file.startsWith("skip/"),
  });
  assert.deepEqual(found.map((item) => item.name), ["keep"]);
});
