import { resolve } from "node:path";

export const MODELS_DATA_DIR = "packages/models/data";

export function resolveModelsDir(cwd: string = process.cwd()): string {
  return resolve(cwd, MODELS_DATA_DIR);
}

export { FAMILY_RULES, inferFamilyFromFolder, inferModelFolder } from "./model/families.ts";
export type { FamilyRule } from "./model/families.ts";
