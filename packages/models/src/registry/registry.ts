import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { aliasesFromUpstream } from "#models/model/clean-key.ts";
import { inferModelFolder } from "#models/model/families.ts";
import { mergeModelData, splitModelData } from "#models/model/merge.ts";
import type { JsonValue, ModelData, ModelIndex, ModelIndexEntry } from "#models/model/types.ts";
import { readModelJson, writeGeneratedModelJson, writeModelJson } from "#models/registry/serialize.ts";

export { buildModelIdMap } from "#models/registry/model-id.ts";
export { readModelJson, writeGeneratedModelJson, writeModelJson };

const MODEL_FILE_EXTENSION = ".json";

function hasMinorVersionSuffix(base: string | undefined, numericSuffix: string | undefined): boolean {
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

/**
 * Sync a provider's model map into the JSON registry.
 *
 * @param {string} modelsDir Path to models/ directory
 * @param {string} providerName e.g. "nvidia_nim"
 * @param {Map<string,string>} modelMap modelKey -> upstreamName
 * @param {{ providerConfigByModel?: Map<string, Record<string, unknown>>, managedProviderConfigKeys?: string[] }} [options]
 * @returns {{ added: string[], removed: string[], updated: string[] }}
 */
export interface SyncOptions {
  providerConfigByModel?: Map<string, Record<string, JsonValue>>;
  managedProviderConfigKeys?: string[];
}

export interface SyncResult {
  added: string[];
  removed: string[];
  updated: string[];
}

export function syncProviderModels(
  modelsDir: string,
  providerName: string,
  modelMap: Map<string, string>,
  options: SyncOptions = {},
): SyncResult {
  const index = buildModelIndex(modelsDir);
  const modelUpstreams = new Set(modelMap.values());
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];

  function extraProviderConfig(modelKey: string): Record<string, JsonValue> {
    return options.providerConfigByModel?.get(modelKey) ?? {};
  }

  function findParentForCollision(modelKey: string, upstreamName: string): { baseKey: string; entry: ModelIndexEntry } | null {
    const entries = Object.values(index);
    if (index[modelKey]) return null;

    const suffixMatch = modelKey.match(/^(.+?)(?:-v(\d+(?:\.\d+)*)|-(\d+))$/);
    if (suffixMatch) {
      const [, base, versionSuffix, numericSuffix] = suffixMatch;
      if (base !== undefined) {
        const isMeaningfulSuffix =
          Boolean(versionSuffix) ||
          (numericSuffix !== undefined && Number.parseInt(numericSuffix, 10) >= 2);
        if (isMeaningfulSuffix && !hasMinorVersionSuffix(base, numericSuffix)) {
          const parent =
            index[base] ||
            entries.find((entry) => entry.id === base) ||
            entries.find((entry) => entry.fileId !== modelKey && (entry.data.aliases || []).includes(base));
          if (parent) return { baseKey: base, entry: parent };
        }
      }
    }
    const covered =
      entries.find(
        (entry) =>
          entry.fileId !== modelKey &&
          (entry.data.aliases || []).includes(upstreamName),
      ) ||
      entries.find(
        (entry) =>
          entry.fileId !== modelKey &&
          getProviderUpstream(entry.data, providerName, entry.fileId) === upstreamName,
      );
    if (covered) return { baseKey: covered.fileId, entry: covered };
    return null;
  }
  for (const [modelKey, upstreamName] of [...modelMap.entries()]) {
    const parent = findParentForCollision(modelKey, upstreamName);
    if (!parent) continue;

    const existingAliases = new Set(parent.entry.data.aliases || []);
    let changed = false;
    for (const alias of aliasesFromUpstream([upstreamName])) {
      if (!existingAliases.has(alias)) {
        existingAliases.add(alias);
        changed = true;
      }
    }
    if (changed) {
      parent.entry.data.aliases = [...existingAliases].sort();
      persistModel(parent.entry, parent.entry.data);
      updated.push(parent.baseKey);
    }
    modelMap.delete(modelKey);
  }

  function applyManagedProviderConfig(providerConfig: Record<string, JsonValue>, modelKey: string): boolean {
    let changed = false;
    const extraConfig = extraProviderConfig(modelKey);
    const managedKeys = options.managedProviderConfigKeys ?? Object.keys(extraConfig);

    for (const key of managedKeys) {
      const nextValue = extraConfig[key];
      if (nextValue === undefined) {
        if (providerConfig[key] !== undefined) {
          delete providerConfig[key];
          changed = true;
        }
        continue;
      }
      if (JSON.stringify(providerConfig[key]) !== JSON.stringify(nextValue)) {
        providerConfig[key] = nextValue;
        changed = true;
      }
    }

    return changed;
  }

  function entryMatchesProviderMap(entry: ModelIndexEntry): boolean {
    if (modelMap.has(entry.fileId) || modelMap.has(entry.id)) return true;
    const upstream = getProviderUpstream(entry.data, providerName, entry.id);
    if (upstream && modelUpstreams.has(upstream)) return true;
    const aliases = entry.data.aliases || [];
    return aliases.some((alias) => modelMap.has(alias) || modelUpstreams.has(alias));
  }

  function findExistingEntry(modelKey: string, upstreamName: string): ModelIndexEntry | null {
    if (index[modelKey]) return index[modelKey];

    const entries = Object.values(index);
    return entries.find((entry) => entry.id === modelKey) ||
      entries.find((entry) => (entry.data.aliases || []).includes(modelKey)) ||
      entries.find((entry) => getProviderUpstream(entry.data, providerName, entry.fileId) === upstreamName) ||
      null;
  }

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(providerName)) continue;
    if (entryMatchesProviderMap(entry)) continue;

    entry.data.providers = providers.filter((provider) => provider !== providerName);

    if (entry.data.providerConfig?.[providerName]) {
      delete entry.data.providerConfig[providerName];
      if (Object.keys(entry.data.providerConfig).length === 0) {
        delete entry.data.providerConfig;
      }
    }

    persistModel(entry, entry.data);
    removed.push(modelId);
  }

  for (const [modelKey, upstreamName] of modelMap.entries()) {
    const existing = findExistingEntry(modelKey, upstreamName);

    if (existing) {
      const providers = existing.data.providers || [];
      let changed = false;

      if (!providers.includes(providerName)) {
        providers.push(providerName);
        existing.data.providers = providers;
        changed = true;
      }

      const extraConfig = extraProviderConfig(modelKey);
      const managedKeys = options.managedProviderConfigKeys ?? Object.keys(extraConfig);
      const providerConfig = existing.data.providerConfig?.[providerName] || {};
      const hasManagedProviderConfig = managedKeys.some((key) => providerConfig[key] !== undefined);

      if (upstreamName !== existing.id || Object.keys(extraConfig).length > 0 || hasManagedProviderConfig || providerConfig.upstream !== undefined) {
        if (!existing.data.providerConfig) existing.data.providerConfig = {};
        if (!existing.data.providerConfig[providerName]) existing.data.providerConfig[providerName] = {};
        const nextProviderConfig = existing.data.providerConfig[providerName] as Record<string, JsonValue>;
        if (applyManagedProviderConfig(nextProviderConfig, modelKey)) {
          changed = true;
        }
        if (upstreamName !== existing.id && nextProviderConfig.upstream !== upstreamName) {
          nextProviderConfig.upstream = upstreamName;
          changed = true;
        }
        if (Object.keys(nextProviderConfig).length === 0) {
          delete existing.data.providerConfig[providerName];
        }
        if (existing.data.providerConfig && Object.keys(existing.data.providerConfig).length === 0) {
          delete existing.data.providerConfig;
        }
      }

      if (changed) {
        persistModel(existing, existing.data);
        updated.push(modelKey);
      }
    } else {
      const folder = inferModelFolder(modelKey);
      const filePath = folder
        ? join(modelsDir, folder, `${modelKey}${MODEL_FILE_EXTENSION}`)
        : join(modelsDir, `${modelKey}${MODEL_FILE_EXTENSION}`);
      if (folder) {
        const folderPath = join(modelsDir, folder);
        if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });
      }

      // If a file with the same canonical name already exists (e.g. as a
      // legacy/ignored catch-all), merge providers/providerConfig into the
      // existing file instead of overwriting it. The existing meta/aliases/
      // ignored flags are preserved.
      if (existsSync(filePath)) {
        const existing = readModelJson(readFileSync(filePath, "utf-8"));
        const existingProviders = existing.providers || [];
        let touched = false;

        if (!existingProviders.includes(providerName)) {
          existing.providers = [...existingProviders, providerName];
          touched = true;
        }

        const extra = extraProviderConfig(modelKey);
        const wantsProviderConfig = Object.keys(extra).length > 0
          || upstreamName !== (existing.id || modelKey)
          || (existing.providerConfig && existing.providerConfig[providerName]);

        if (wantsProviderConfig) {
          if (!existing.providerConfig) existing.providerConfig = {};
          if (!existing.providerConfig[providerName]) existing.providerConfig[providerName] = {};
          const nextProviderConfig = existing.providerConfig[providerName];
          for (const [key, value] of Object.entries(extra)) {
            if (JSON.stringify(nextProviderConfig[key]) !== JSON.stringify(value)) {
              nextProviderConfig[key] = value;
              touched = true;
            }
          }
          if (upstreamName !== modelKey && nextProviderConfig.upstream !== upstreamName) {
            nextProviderConfig.upstream = upstreamName;
            touched = true;
          }
          if (Object.keys(nextProviderConfig).length === 0) {
            delete existing.providerConfig[providerName];
          }
          if (Object.keys(existing.providerConfig).length === 0) {
            delete existing.providerConfig;
          }
        }

        if (touched) {
          persistModel({ modelsDir, relativeId: folder ? `${folder}/${modelKey}` : modelKey }, existing);
          updated.push(modelKey);
        }
        continue;
      }

      const data: ModelData = {
        providers: [providerName],
      };

      const providerConfig = { ...extraProviderConfig(modelKey) };
      if (upstreamName !== modelKey) {
        providerConfig.upstream = upstreamName;
      }
      if (Object.keys(providerConfig).length > 0) {
        data.providerConfig = {
          [providerName]: providerConfig,
        };
      }

      persistModel({ modelsDir, relativeId: folder ? `${folder}/${modelKey}` : modelKey }, data);
      added.push(modelKey);
    }
  }

  return { added, removed, updated };
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
