import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import { MODELS_DATA_DIR, resolveModelsDir } from "./index.ts";

test("resolveModelsDir defaults to the repo-relative data directory", () => {
  const original = process.env.MODELS_DIR;
  delete process.env.MODELS_DIR;
  try {
    assert.equal(resolveModelsDir("/base/dir"), resolve("/base/dir", MODELS_DATA_DIR));
  } finally {
    if (original === undefined) delete process.env.MODELS_DIR;
    else process.env.MODELS_DIR = original;
  }
});

test("resolveModelsDir honors the MODELS_DIR override", () => {
  const original = process.env.MODELS_DIR;
  process.env.MODELS_DIR = "/custom/models";
  try {
    assert.equal(resolveModelsDir("/base/dir"), resolve("/custom/models"));
  } finally {
    if (original === undefined) delete process.env.MODELS_DIR;
    else process.env.MODELS_DIR = original;
  }
});
