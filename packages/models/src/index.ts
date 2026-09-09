import { resolve } from "node:path";

export function resolveModelsDir(cwd = process.cwd()): string {
  if (process.env.MODELS_DIR) {
    return resolve(process.env.MODELS_DIR);
  }
  return resolve(cwd, "packages/models/data");
}
