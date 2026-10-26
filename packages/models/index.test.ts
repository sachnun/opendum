import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { MODELS_DATA_DIR, modelsDir } from "@opendum/models/index";

test("modelsDir defaults to the repo-relative data directory", () => {
  expect(modelsDir("/base/dir")).toBe(resolve("/base/dir", MODELS_DATA_DIR));
});
