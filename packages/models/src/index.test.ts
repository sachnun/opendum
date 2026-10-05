import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { MODELS_DATA_DIR, MODELS_GENERATED_DIR, resolveGeneratedModelsDir, resolveModelsDir } from "#models/index.ts";

const original = process.env.MODELS_GENERATED_DIR;

afterEach(() => {
  if (original === undefined) delete process.env.MODELS_GENERATED_DIR;
  else process.env.MODELS_GENERATED_DIR = original;
});

describe("models path helpers", () => {
  it("resolves the data and generated directories", () => {
    assert.equal(MODELS_DATA_DIR, "packages/models/data");
    assert.equal(MODELS_GENERATED_DIR, "packages/models/generated");
    assert.equal(resolveModelsDir("/root"), "/root/packages/models/data");
    assert.equal(resolveGeneratedModelsDir("/root"), "/root/packages/models/generated");
  });

  it("honours MODELS_GENERATED_DIR", () => {
    process.env.MODELS_GENERATED_DIR = "/custom/generated";
    assert.equal(resolveGeneratedModelsDir("/root"), "/custom/generated");
  });
});
