import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { MODELS_DATA_DIR, resolveModelsDir } from "./index.ts";

test("resolveModelsDir defaults to the repo-relative data directory", () => {
  expect(resolveModelsDir("/base/dir")).toBe(resolve("/base/dir", MODELS_DATA_DIR));
});
