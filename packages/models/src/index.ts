/**
 * Opendum model registry.
 *
 * Runtime helpers for locating the model data directory. The data itself lives
 * in `data/` and is maintained by the refresh scripts in `scripts/`.
 */

import { resolve } from "node:path";

export const MODELS_DATA_DIR = "packages/models/data";

export function resolveModelsDir(cwd: string = process.cwd()): string {
  const configured = process.env.MODELS_DIR;
  if (configured) return resolve(configured);
  return resolve(cwd, MODELS_DATA_DIR);
}

export { FAMILY_RULES, inferFamilyFromFolder, inferModelFolder } from "./families.ts";
export type { FamilyRule } from "./families.ts";
