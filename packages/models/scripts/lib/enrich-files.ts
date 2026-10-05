import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, renameSync } from "node:fs";

import { inferModelFolder } from "#models/model/families.ts";
import { buildModelIndex } from "#models/registry/registry.ts";

export function relocateRootFiles(modelsDir: string, dryRun: boolean): string[] {
  const index = buildModelIndex(modelsDir);
  const moved: string[] = [];
  for (const [fileId, entry] of Object.entries(index)) {
    if (dirname(entry.path) !== modelsDir) continue;
    const id = entry.id || fileId;
    const folder = inferModelFolder(id);
    if (!folder) continue;
    const target = join(modelsDir, folder, basename(entry.path));
    if (existsSync(target)) continue;
    moved.push(`${id} -> ${folder}/`);
    if (!dryRun) {
      mkdirSync(join(modelsDir, folder), { recursive: true });
      renameSync(entry.path, target);
    }
  }
  return moved;
}
