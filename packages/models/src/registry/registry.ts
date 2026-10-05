import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { mergeModelData, splitModelData } from "#models/model/merge.ts";
import type { ModelData, ModelIndex, ModelIndexEntry } from "#models/model/types.ts";
import { readModelJson, writeGeneratedModelJson, writeModelJson } from "#models/registry/serialize.ts";

export { buildModelIdMap } from "#models/registry/model-id.ts";
export { syncProviderModels } from "#models/registry/sync.ts";
export type { SyncOptions, SyncResult } from "#models/registry/sync.ts";
export { readModelJson, writeGeneratedModelJson, writeModelJson };

export const MODEL_FILE_EXTENSION = ".json";

export function hasMinorVersionSuffix(base: string | undefined, numericSuffix: string | undefined): boolean {
  if (!base || !numericSuffix) return false;
  return /-(?:\d+)$/.test(base) || /-v\d+(?:\.\d+)*$/.test(base);
}

function getModelPublicId(data: ModelData, fileId: string): string {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  return id || fileId;
}

export function writeSplitModel(
  modelsDir: string,
  fileId: string,
  data: ModelData,
  options: { generatedDir?: string } = {},
): { authoredPath: string; generatedPath: string } {
  const generatedDir = options.generatedDir ?? resolveGeneratedDir(modelsDir);
  const { generated, authored } = splitModelData(data);
  const authoredPath = join(modelsDir, fileId + MODEL_FILE_EXTENSION);
  const generatedPath = join(generatedDir, fileId + MODEL_FILE_EXTENSION);

  if (Object.keys(authored).length > 0) {
    mkdirSync(dirname(authoredPath), { recursive: true });
    writeModelJson(authoredPath, authored);
  } else if (existsSync(authoredPath)) {
    rmSync(authoredPath, { force: true });
  }

  if (Object.keys(generated).length > 0) {
    writeGeneratedModelJson(generatedPath, generated);
  } else if (existsSync(generatedPath)) {
    rmSync(generatedPath, { force: true });
  }

  return { authoredPath, generatedPath };
}

export function collectModelFiles(modelsDir: string): string[] {
  const files: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(modelsDir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(modelsDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const file of readdirSync(fullPath)) {
        if (file.endsWith(MODEL_FILE_EXTENSION)) {
          files.push(join(fullPath, file));
        }
      }
    } else if (entry.endsWith(MODEL_FILE_EXTENSION)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function resolveGeneratedDir(modelsDir: string): string {
  const configured = process.env.MODELS_GENERATED_DIR;
  if (configured) return resolve(configured);
  return join(dirname(modelsDir), "generated");
}

function readModelData(filePath: string): ModelData {
  return readModelJson(readFileSync(filePath, "utf-8"));
}

function collectByFileId(modelsDir: string): Map<string, string> {
  const byFileId = new Map<string, string>();
  for (const filePath of collectModelFiles(modelsDir)) {
    const relativePath = relative(modelsDir, filePath);
    byFileId.set(
      relativePath.replace(/\.json$/, "").split(sep).join("/"),
      filePath,
    );
  }
  return byFileId;
}

export function buildModelIndex(modelsDir: string, options: { generatedDir?: string } = {}): ModelIndex {
  const generatedDir = options.generatedDir ?? resolveGeneratedDir(modelsDir);
  const authoredFiles = collectByFileId(modelsDir);
  const generatedFiles = collectByFileId(generatedDir);
  const index: ModelIndex = {};

  for (const relativeId of new Set([...authoredFiles.keys(), ...generatedFiles.keys()])) {
    const authoredPath = authoredFiles.get(relativeId);
    const generatedPath = generatedFiles.get(relativeId);
    const authored = authoredPath ? readModelData(authoredPath) : undefined;
    const generated = generatedPath ? readModelData(generatedPath) : undefined;
    const data = mergeModelData(generated, authored);
    index[relativeId] = {
      id: getModelPublicId(data, basename(relativeId)),
      fileId: basename(relativeId),
      relativeId,
      path: authoredPath ?? generatedPath!,
      generatedPath,
      modelsDir,
      generatedDir,
      data,
    };
  }
  return index;
}

export function generatedModelPath(generatedDir: string, relativeId: string): string {
  return join(generatedDir, relativeId + MODEL_FILE_EXTENSION);
}

export function persistModel(entry: Pick<ModelIndexEntry, "modelsDir" | "relativeId">, data: ModelData): void {
  writeSplitModel(entry.modelsDir, entry.relativeId, data);
}

export function renameModelFiles(
  entry: Pick<ModelIndexEntry, "modelsDir" | "generatedDir" | "relativeId">,
  nextFileId: string,
): string {
  const folder = dirname(entry.relativeId);
  const nextRelativeId = folder === "." ? nextFileId : join(folder, nextFileId);
  if (nextRelativeId === entry.relativeId) return entry.relativeId;

  const pairs = [entry.modelsDir, entry.generatedDir].map((base) => ({
    from: join(base, entry.relativeId + MODEL_FILE_EXTENSION),
    to: join(base, nextRelativeId + MODEL_FILE_EXTENSION),
  }));
  if (pairs.some(({ to }) => existsSync(to))) return entry.relativeId;

  for (const { from, to } of pairs) {
    if (!existsSync(from)) continue;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  return nextRelativeId;
}

function hasCuratedData(data: ModelData): boolean {
  const authored = splitModelData(data).authored as Record<string, unknown>;
  delete authored.ignored;
  return Object.keys(authored).length > 0;
}

export function pruneDeadModelEntries(modelsDir: string): string[] {
  const index = buildModelIndex(modelsDir);
  const removed: string[] = [];

  for (const entry of Object.values(index)) {
    if ((entry.data.providers ?? []).length > 0) continue;
    if (hasCuratedData(entry.data)) continue;
    writeSplitModel(entry.modelsDir, entry.relativeId, {});
    removed.push(entry.id);
  }

  return removed.sort();
}

export function getProviderUpstream(data: ModelData, providerName: string, modelId: string): string | undefined {
  const providerConfig = data.providerConfig?.[providerName];
  if (
    providerConfig &&
    typeof providerConfig === "object" &&
    !Array.isArray(providerConfig) &&
    typeof providerConfig.upstream === "string" &&
    providerConfig.upstream.trim().length > 0
  ) {
    return providerConfig.upstream.trim();
  }

  return modelId;
}
