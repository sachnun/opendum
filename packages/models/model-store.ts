import { Effect } from "effect";

import { aliasesOf, isDate } from "@opendum/models/model/clean-key";
import { folderOf } from "@opendum/models/model/families";
import { mergeData, splitData } from "@opendum/models/model/merge";
import { ModelParseFailure, ModelWriteFailure, asError } from "@opendum/models/errors";
import {
  exists,
  listJson,
  readJson,
  tryRemove,
  tryRename,
  saveText,
} from "@opendum/models/fs";
import { basename, dirname, join, relative, sep } from "@opendum/models/paths";
import type { JsonValue, ModelData, ModelIndex, ModelIndexEntry } from "@opendum/models/types";

const MODEL_EXT = ".json";

const MODEL_ORDER = [
  "id",
  "providers",
  "aliases",
  "description",
  "ignored",
  "reasoning",
  "reasoning_effort",
  "modalities",
  "limit",
  "cost",
  "scores",
  "providerConfig",
];

const CONFIG_ORDER = ["upstream", "contextWindow", "maxOutputTokens", "authless", "free", "minTier", "allowedTiers", "aliases"];
const COST_ORDER = ["input", "output", "cacheRead", "cacheWrite"];
const SCORE_ORDER = ["index", "estimated", "version"];

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function orderObject(value: Record<string, JsonValue>, preferredKeys: string[] = []): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  const preferred = new Set(preferredKeys);

  for (const key of preferredKeys) {
    if (value[key] !== undefined) {
      result[key] = orderValue(value[key], key);
    }
  }

  for (const key of Object.keys(value).filter((key) => !preferred.has(key)).sort()) {
    if (value[key] !== undefined) {
      result[key] = orderValue(value[key], key);
    }
  }

  return result;
}

function orderProviders(value: Record<string, JsonValue>, preferredKeys: string[]): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const provider of Object.keys(value).sort()) {
    const entry = value[provider];
    result[provider] = isObject(entry)
      ? orderObject(entry, preferredKeys)
      : orderValue(entry!, provider);
  }
  return result;
}

function orderValue(value: JsonValue, key?: string): JsonValue {
  if (key === "aliases" && Array.isArray(value)) return [...(value as string[])].sort();
  if (Array.isArray(value)) return value.map((item) => orderValue(item));
  if (!isObject(value)) return value;

  if (key === "providerConfig") return orderProviders(value, CONFIG_ORDER);
  if (key === "cost") return orderObject(value, COST_ORDER);
  if (key === "scores") return orderScores(value);
  return orderObject(value);
}

function orderScores(value: JsonValue): JsonValue {
  if (!isObject(value)) return value;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort()) {
    result[key] = orderObject(value[key] as Record<string, JsonValue>, SCORE_ORDER);
  }
  return result;
}

function normalizeData(data: ModelData): Record<string, JsonValue> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    delete data.family;
  }
  return orderObject(data as Record<string, JsonValue>, MODEL_ORDER);
}

export function read(content: string): ModelData {
  return JSON.parse(content) as ModelData;
}

export function tryRead(
  content: string,
  path = "<inline>"
): Effect.Effect<ModelData, ModelParseFailure> {
  return Effect.try({
    try: () => read(content),
    catch: (cause) => cause,
  }).pipe(
    Effect.mapError(
      (cause) => new ModelParseFailure({ message: asError(cause).message, path, cause })
    )
  );
}

function hasVersion(base: string | undefined, numericSuffix: string | undefined): boolean {
  if (!base || !numericSuffix) return false;
  return /-(?:\d+)$/.test(base) || /-v\d+(?:\.\d+)*$/.test(base);
}

function publicId(data: ModelData, fileId: string): string {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  return id || fileId;
}

export function tryWrite(
  filePath: string,
  data: ModelData
): Effect.Effect<void, ModelWriteFailure> {
  const content = JSON.stringify(normalizeData(data), null, 2);
  return saveText(filePath, `${content}\n`);
}

export function write(filePath: string, data: ModelData): Promise<void> {
  return Effect.runPromise(tryWrite(filePath, data));
}

export function writeGenerated(filePath: string, data: ModelData): Promise<void> {
  return Effect.runPromise(tryWrite(filePath, data));
}

export function writeSplit(
  modelsDir: string,
  fileId: string,
  data: ModelData,
  options: { generatedDir?: string } = {},
): Effect.Effect<{ authoredPath: string; generatedPath: string }, ModelWriteFailure> {
  return Effect.gen(function* () {
    const dir = options.generatedDir ?? generatedDir(modelsDir);
    const { generated, authored } = splitData(data);
    const authoredPath = join(modelsDir, fileId + MODEL_EXT);
    const generatedPath = join(dir, fileId + MODEL_EXT);

    if (Object.keys(authored).length > 0) {
      yield* tryWrite(authoredPath, authored);
    } else if (exists(authoredPath)) {
      yield* tryRemove(authoredPath);
    }

    if (Object.keys(generated).length > 0) {
      yield* tryWrite(generatedPath, generated);
    } else if (exists(generatedPath)) {
      yield* tryRemove(generatedPath);
    }

    return { authoredPath, generatedPath };
  });
}

export function saveSplit(
  modelsDir: string,
  fileId: string,
  data: ModelData,
  options: { generatedDir?: string } = {},
): Promise<{ authoredPath: string; generatedPath: string }> {
  return Effect.runPromise(writeSplit(modelsDir, fileId, data, options));
}

export function collectFiles(modelsDir: string): string[] {
  return listJson(modelsDir)
    .filter((relativePath) => relativePath.split("/").length <= 2)
    .map((relativePath) => join(modelsDir, relativePath));
}

export function generatedDir(modelsDir: string): string {
  return join(dirname(modelsDir), "generated");
}

function readData(filePath: string): ModelData {
  return readJson(filePath) as ModelData;
}

function byFile(modelsDir: string): Map<string, string> {
  const byFile = new Map<string, string>();
  for (const filePath of collectFiles(modelsDir)) {
    const relativePath = relative(modelsDir, filePath);
    byFile.set(
      relativePath.replace(/\.json$/, "").split(sep).join("/"),
      filePath,
    );
  }
  return byFile;
}

export function buildIndex(modelsDir: string, options: { generatedDir?: string } = {}): ModelIndex {
  const dir = options.generatedDir ?? generatedDir(modelsDir);
  const authoredFiles = byFile(modelsDir);
  const generatedFiles = byFile(dir);
  const index: ModelIndex = {};

  for (const relativeId of new Set([...authoredFiles.keys(), ...generatedFiles.keys()])) {
    const authoredPath = authoredFiles.get(relativeId);
    const generatedPath = generatedFiles.get(relativeId);
    const authored = authoredPath ? readData(authoredPath) : undefined;
    const generated = generatedPath ? readData(generatedPath) : undefined;
    const data = mergeData(generated, authored);
    index[relativeId] = {
      id: publicId(data, basename(relativeId)),
      fileId: basename(relativeId),
      relativeId,
      path: authoredPath ?? generatedPath!,
      generatedPath,
      modelsDir,
      generatedDir: dir,
      data,
    };
  }
  return index;
}

export function generatedPath(generatedDir: string, relativeId: string): string {
  return join(generatedDir, relativeId + MODEL_EXT);
}

function dateToken(modelId: string): string | null {
  const segment = modelId.slice(modelId.lastIndexOf("/") + 1);
  const tokens = segment.split(/[-_]/);
  const tail = (tokens[tokens.length - 1] ?? "").split(":")[0] ?? "";
  return isDate(tail) ? tail : null;
}

function compare(left: { dateToken: string | null }, right: { dateToken: string | null }): number {
  if (left.dateToken === null && right.dateToken === null) return 0;
  if (left.dateToken === null) return -1;
  if (right.dateToken === null) return 1;
  return Number.parseInt(right.dateToken, 10) - Number.parseInt(left.dateToken, 10);
}

export function idMap(modelIds: string[], modelKey: (modelId: string) => string): Map<string, string> {
  const groups = new Map<string, Array<{ modelId: string; key: string; dateToken: string | null }>>();

  for (const modelId of modelIds) {
    const key = modelKey(modelId);
    if (!key) continue;

    const token = dateToken(modelId);
    const baseKey =
      token && key.endsWith(`-${token}`)
        ? key.slice(0, key.length - token.length - 1)
        : key;

    const group = groups.get(baseKey);
    if (group) group.push({ modelId, key, dateToken: token });
    else groups.set(baseKey, [{ modelId, key, dateToken: token }]);
  }

  const map = new Map<string, string>();
  for (const [baseKey, candidates] of groups) {
    candidates.sort(compare);

    const [winner, ...losers] = candidates;
    if (winner === undefined) continue;
    map.set(baseKey, winner.modelId);

    for (const loser of losers) {
      const stem = loser.dateToken ? `${baseKey}-${loser.dateToken}` : loser.key;
      let key = stem;
      let suffix = 2;
      while (map.has(key) && map.get(key) !== loser.modelId) {
        key = `${stem}-${suffix}`;
        suffix += 1;
      }
      map.set(key, loser.modelId);
    }
  }

  return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function persist(
  entry: Pick<ModelIndexEntry, "modelsDir" | "relativeId">,
  data: ModelData,
): Promise<{ authoredPath: string; generatedPath: string }> {
  return saveSplit(entry.modelsDir, entry.relativeId, data);
}

export function renameFiles(
  entry: Pick<ModelIndexEntry, "modelsDir" | "generatedDir" | "relativeId">,
  nextFileId: string,
): Effect.Effect<string, ModelWriteFailure> {
  return Effect.gen(function* () {
    const folder = dirname(entry.relativeId);
    const nextRelativeId = folder === "." ? nextFileId : join(folder, nextFileId);
    if (nextRelativeId === entry.relativeId) return entry.relativeId;

    const pairs = [entry.modelsDir, entry.generatedDir].map((base) => ({
      from: join(base, entry.relativeId + MODEL_EXT),
      to: join(base, nextRelativeId + MODEL_EXT),
    }));
    if (pairs.some(({ to }) => exists(to))) return entry.relativeId;

    for (const { from, to } of pairs) {
      if (!exists(from)) continue;
      yield* tryRename(from, to).pipe(
        Effect.mapError((cause) =>
          cause._tag === "ModelWriteFailure"
            ? cause
            : new ModelWriteFailure({ message: cause.message, path: from, cause })
        )
      );
    }
    return nextRelativeId;
  });
}

export function moveFiles(
  entry: Pick<ModelIndexEntry, "modelsDir" | "generatedDir" | "relativeId">,
  nextFileId: string,
): Promise<string> {
  return Effect.runPromise(renameFiles(entry, nextFileId));
}

function isCurated(data: ModelData): boolean {
  const authored = splitData(data).authored as Record<string, unknown>;
  delete authored.ignored;
  return Object.keys(authored).length > 0;
}

export function tryPrune(modelsDir: string): Effect.Effect<string[], ModelWriteFailure> {
  return Effect.gen(function* () {
    const index = buildIndex(modelsDir);
    const removed: string[] = [];

    for (const entry of Object.values(index)) {
      if ((entry.data.providers ?? []).length > 0) continue;
      if (isCurated(entry.data)) continue;
      yield* writeSplit(entry.modelsDir, entry.relativeId, {});
      removed.push(entry.id);
    }

    return removed.sort();
  });
}

export function prune(modelsDir: string): Promise<string[]> {
  return Effect.runPromise(tryPrune(modelsDir));
}

export interface Options {
  providerConfig?: Map<string, Record<string, JsonValue>>;
  managedProviderConfigKeys?: string[];
  dryRun?: boolean;
}

export interface Result {
  added: string[];
  removed: string[];
  updated: string[];
}

export async function sync(
  modelsDir: string,
  providerName: string,
  modelMap: Map<string, string>,
  options: Options = {},
): Promise<Result> {
  const index = buildIndex(modelsDir);
  const modelUpstreams = new Set(modelMap.values());
  const added: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  const persistIf = async (
    entry: Pick<ModelIndexEntry, "modelsDir" | "relativeId">,
    data: ModelData,
  ): Promise<void> => {
    if (options.dryRun === true) return;
    await persist(entry, data);
  };

  function extraConfig(modelKey: string): Record<string, JsonValue> {
    return options.providerConfig?.get(modelKey) ?? {};
  }

  function findParent(modelKey: string, upstreamName: string): { baseKey: string; entry: ModelIndexEntry } | null {
    const entries = Object.values(index);
    if (index[modelKey]) return null;

    const suffixMatch = modelKey.match(/^(.+?)(?:-v(\d+(?:\.\d+)*)|-(\d+))$/);
    if (suffixMatch) {
      const [, base, versionSuffix, numericSuffix] = suffixMatch;
      if (base !== undefined) {
        const isMeaningfulSuffix =
          Boolean(versionSuffix) ||
          (numericSuffix !== undefined && Number.parseInt(numericSuffix, 10) >= 2);
        if (isMeaningfulSuffix && !hasVersion(base, numericSuffix)) {
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
          upstream(entry.data, providerName, entry.fileId) === upstreamName,
      );
    if (covered) return { baseKey: covered.fileId, entry: covered };
    return null;
  }
  for (const [modelKey, upstreamName] of modelMap.entries()) {
    const parent = findParent(modelKey, upstreamName);
    if (!parent) continue;

    const existingAliases = new Set(parent.entry.data.aliases || []);
    let changed = false;
    for (const alias of aliasesOf([upstreamName])) {
      if (!existingAliases.has(alias)) {
        existingAliases.add(alias);
        changed = true;
      }
    }
    if (changed) {
      parent.entry.data.aliases = [...existingAliases].sort();
      await persistIf(parent.entry, parent.entry.data);
      updated.push(parent.baseKey);
    }
    modelMap.delete(modelKey);
  }

  function applyManaged(providerConfig: Record<string, JsonValue>, modelKey: string): boolean {
    let changed = false;
    const extras = extraConfig(modelKey);
    const managedKeys = options.managedProviderConfigKeys ?? Object.keys(extras);

    for (const key of managedKeys) {
      const nextValue = extras[key];
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

  function matchesProvider(entry: ModelIndexEntry): boolean {
    if (modelMap.has(entry.fileId) || modelMap.has(entry.id)) return true;
    const name = upstream(entry.data, providerName, entry.id);
    if (name && modelUpstreams.has(name)) return true;
    const aliases = entry.data.aliases || [];
    return aliases.some((alias) => modelMap.has(alias) || modelUpstreams.has(alias));
  }

  function findEntry(modelKey: string, upstreamName: string): ModelIndexEntry | null {
    if (index[modelKey]) return index[modelKey];

    const entries = Object.values(index);
    return entries.find((entry) => entry.id === modelKey) ||
      entries.find((entry) => (entry.data.aliases || []).includes(modelKey)) ||
      entries.find((entry) => upstream(entry.data, providerName, entry.fileId) === upstreamName) ||
      null;
  }

  for (const [modelId, entry] of Object.entries(index)) {
    const providers = entry.data.providers || [];
    if (!providers.includes(providerName)) continue;
    if (matchesProvider(entry)) continue;

    entry.data.providers = providers.filter((provider) => provider !== providerName);

    if (entry.data.providerConfig?.[providerName]) {
      delete entry.data.providerConfig[providerName];
      if (Object.keys(entry.data.providerConfig).length === 0) {
        delete entry.data.providerConfig;
      }
    }

    await persistIf(entry, entry.data);
    removed.push(modelId);
  }

  for (const [modelKey, upstreamName] of modelMap.entries()) {
    const existing = findEntry(modelKey, upstreamName);

    if (existing) {
      const providers = existing.data.providers || [];
      let changed = false;

      if (!providers.includes(providerName)) {
        providers.push(providerName);
        existing.data.providers = providers;
        changed = true;
      }

      const extras = extraConfig(modelKey);
      const managedKeys = options.managedProviderConfigKeys ?? Object.keys(extras);
      const providerConfig = existing.data.providerConfig?.[providerName] || {};
      const hasManaged = managedKeys.some((key) => providerConfig[key] !== undefined);

      if (upstreamName !== existing.id || Object.keys(extras).length > 0 || hasManaged || providerConfig.upstream !== undefined) {
        if (!existing.data.providerConfig) existing.data.providerConfig = {};
        if (!existing.data.providerConfig[providerName]) existing.data.providerConfig[providerName] = {};
        const nextProviderConfig = existing.data.providerConfig[providerName] as Record<string, JsonValue>;
        if (applyManaged(nextProviderConfig, modelKey)) {
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
        await persistIf(existing, existing.data);
        updated.push(modelKey);
      }
    } else {
      const folder = folderOf(modelKey);
      const relativeId = folder ? `${folder}/${modelKey}` : modelKey;
      const filePath = join(modelsDir, `${relativeId}${MODEL_EXT}`);

      if (exists(filePath)) {
        const existing = readJson(filePath) as ModelData;
        const existingProviders = existing.providers || [];
        let touched = false;

        if (!existingProviders.includes(providerName)) {
          existing.providers = [...existingProviders, providerName];
          touched = true;
        }

        const extra = extraConfig(modelKey);
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
          await persistIf({ modelsDir, relativeId }, existing);
          updated.push(modelKey);
        }
        continue;
      }

      const data: ModelData = {
        providers: [providerName],
      };

      const providerConfig = { ...extraConfig(modelKey) };
      if (upstreamName !== modelKey) {
        providerConfig.upstream = upstreamName;
      }
      if (Object.keys(providerConfig).length > 0) {
        data.providerConfig = {
          [providerName]: providerConfig,
        };
      }

      await persistIf({ modelsDir, relativeId }, data);
      added.push(modelKey);
    }
  }

  return { added, removed, updated };
}

export function upstream(data: ModelData, providerName: string, modelId: string): string | undefined {
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
