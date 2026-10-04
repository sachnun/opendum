#!/usr/bin/env node

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readModelJson, resolveGeneratedDir, writeSplitModel } from "#models/registry.ts";
import { splitModelData } from "#models/merge.ts";
import type { ModelData } from "#models/types.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const modelsDir = resolve(scriptDir, "../data");

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (entry.endsWith(".json")) out.push(full);
  }
  return out;
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const files = collectFiles(modelsDir);
  const generatedDir = resolveGeneratedDir(modelsDir);
  let split = 0;

  for (const path of files) {
    const fileId = basename(path, ".json");
    const folder = dirname(path) === modelsDir ? "" : basename(dirname(path));
    const relativeId = folder ? `${folder}/${fileId}` : fileId;

    const generatedPath = join(generatedDir, relativeId + ".json");
    if (existsSync(generatedPath)) continue;

    const data = readModelJson(readFileSync(path, "utf-8")) as ModelData;
    if (!data || typeof data !== "object") continue;
    if (Object.keys(splitModelData(data).generated).length === 0) continue;

    if (dryRun) {
      console.log(`[split] ${relative(modelsDir, path)}`);
      split += 1;
      continue;
    }
    writeSplitModel(modelsDir, relativeId, data);
    split += 1;
  }

  console.log(`[split] ${split} model documents ${dryRun ? "(dry run)" : "split"}`);
}

main();
