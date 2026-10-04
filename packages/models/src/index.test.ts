import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { MODELS_DATA_DIR, resolveModelsDir } from "#models/index.ts";

test("resolveModelsDir defaults to the repo-relative data directory", () => {
  assert.equal(resolveModelsDir("/base/dir"), resolve("/base/dir", MODELS_DATA_DIR));
});
