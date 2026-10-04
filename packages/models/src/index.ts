import { resolve } from "node:path";

export const MODELS_DATA_DIR = "packages/models/data";
export const MODELS_GENERATED_DIR = "packages/models/generated";

export function resolveModelsDir(cwd: string = process.cwd()): string {
  return resolve(cwd, MODELS_DATA_DIR);
}

export function resolveGeneratedModelsDir(cwd: string = process.cwd()): string {
  const configured = process.env.MODELS_GENERATED_DIR;
  if (configured) return resolve(configured);
  return resolve(cwd, MODELS_GENERATED_DIR);
}

export { FAMILY_RULES, inferFamilyFromFolder, inferModelFolder } from "#models/model/families.ts";
export type { FamilyRule } from "#models/model/families.ts";
