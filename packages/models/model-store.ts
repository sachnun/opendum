import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Effect } from "effect";

import { aliasesFromUpstream, isDateToken } from "./model/clean-key.ts";
import { inferModelFolder } from "./model/families.ts";
import { mergeModelData, splitModelData } from "./model/merge.ts";
import { ModelParseFailure, asError } from "./errors.ts";
import type { JsonValue, ModelData, ModelIndex, ModelIndexEntry } from "./types.ts";

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

/**
 * Effect wrapper around {@link read} that reports invalid JSON as a
 * typed parse failure instead of a thrown `SyntaxError`.
 */
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

function hasVersionSuffix(base: string | undefined, numericSuffix: string | undefined): boolean {
  if (!base || !numericSuffix) return false;
  return /-(?:\d+)$/.test(base) || /-v\d+(?:\.\d+)*$/.test(base);
}

function publicId(data: ModelData, fileId: string): string {
  const id = typeof data.id === "string" ? data.id.trim() : "";
  return id || fileId;
}

export function write(filePath: string, data: ModelData): void {
  const content = JSON.stringify(normalizeData(data), null, 2);
  writeFileSync(filePath, `${content}\n`);
}

export function writeGenerated(filePath: string, data: ModelData): void {
  mkdirSync(dirname(filePath), { recursive: true });
  write(filePath, data);
}

export function writeSplit(
  modelsDir: string,
  fileId: string,
  data: ModelData,
  options: { generatedDir?: string } = {},
): { authoredPath: string; generatedPath: string } {
  const dir = options.generatedDir ?? generatedDir(modelsDir);
  const { generated, authored } = splitModelData(data);
  const authoredPath = join(modelsDir, fileId + MODEL_EXT);
  const generatedPath = join(dir, fileId + MODEL_EXT);

  if (Object.keys(authored).length > 0) {
    mkdirSync(dirname(authoredPath), { recursive: true });
    write(authoredPath, authored);
  } else if (existsSync(authoredPath)) {
    rmSync(authoredPath, { force: true });
  }

  if (Object.keys(generated).length > 0) {
    writeGenerated(generatedPath, generated);
  } else if (existsSync(generatedPath)) {
    rmSync(generatedPath, { force: true });
  }

  return { authoredPath, generatedPath };
}

export function collectFiles(modelsDir: string): string[] {
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
        if (file.endsWith(MODEL_EXT)) {
          files.push(join(fullPath, file));
        }
      }
    } else if (entry.endsWith(MODEL_EXT)) {
      files.push(fullPath);
    }
  }
  return files;
}

export function generatedDir(modelsDir: string): string {
  const configured = process.env.MODELS_GENERATED_DIR;
  if (configured) return resolve(configured);
  return join(dirname(modelsDir), "generated");
}

function readData(filePath: string): ModelData {
  return read(readFileSync(filePath, "utf-8"));
}

function byFileId(modelsDir: string): Map<string, string> {
  const byFileId = new Map<string, string>();
  for (const filePath of collectFiles(modelsDir)) {
    const relativePath = relative(modelsDir, filePath);
    byFileId.set(
      relativePath.replace(/\.json$/, "").split(sep).join("/"),
      filePath,
    );
  }
  return byFileId;
}

export function buildIndex(modelsDir: string, options: { generatedDir?: string } = {}): ModelIndex {
  const dir = options.generatedDir ?? generatedDir(modelsDir);
  const authoredFiles = byFileId(modelsDir);
  const generatedFiles = byFileId(dir);
  const index: ModelIndex = {};

  for (const relativeId of new Set([...authoredFiles.keys(), ...generatedFiles.keys()])) {
    const authoredPath = authoredFiles.get(relativeId);
    const generatedPath = generatedFiles.get(relativeId);
    const authored = authoredPath ? readData(authoredPath) : undefined;
    const generated = generatedPath ? readData(generatedPath) : undefined;
    const data = mergeModelData(generated, authored);
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
  return isDateToken(tail) ? tail : null;
}

function compareCandidates(left: { dateToken: string | null }, right: { dateToken: string | null }): number {
  if (left.dateToken === null && right.dateToken === null) return 0;
  if (left.dateToken === null) return -1;
  if (right.dateToken === null) return 1;
  return Number.parseInt(right.dateToken, 10) - Number.parseInt(left.dateToken, 10);
}

/**
 * Build a modelKey -> upstreamId map from a raw provider model id list.
 *
 * Provider feeds often carry both a rolling base id and date-pinned variants
 * of the same model (e.g. `deepseek/deepseek-v4-flash` next to
 * `deepseek/deepseek-v4-flash-0731` or `-0813`). All of them normalize to the
 * same base key via `toModelKey`; this helper makes the newest variant own
 * the base key (an undated rolling id counts as the newest) and re-keys
 * older date-pinned variants under `base-<date>` so the registry merge turns
 * them into aliases instead of separate models.
 */
export function idMap(modelIds: string[], toModelKey: (modelId: string) => string): Map<string, string> {
  const groups = new Map<string, Array<{ modelId: string; key: string; dateToken: string | null }>>();

  for (const modelId of modelIds) {
    const key = toModelKey(modelId);
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
    candidates.sort(compareCandidates);

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

export function persist(entry: Pick<ModelIndexEntry, "modelsDir" | "relativeId">, data: ModelData): void {
  writeSplit(entry.modelsDir, entry.relativeId, data);
}

export function renameFiles(
  entry: Pick<ModelIndexEntry, "modelsDir" | "generatedDir" | "relativeId">,
  nextFileId: string,
): string {
  const folder = dirname(entry.relativeId);
  const nextRelativeId = folder === "." ? nextFileId : join(folder, nextFileId);
  if (nextRelativeId === entry.relativeId) return entry.relativeId;

  const pairs = [entry.modelsDir, entry.generatedDir].map((base) => ({
    from: join(base, entry.relativeId + MODEL_EXT),
    to: join(base, nextRelativeId + MODEL_EXT),
  }));
  if (pairs.some(({ to }) => existsSync(to))) return entry.relativeId;

  for (const { from, to } of pairs) {
    if (!existsSync(from)) continue;
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }
  return nextRelativeId;
}

function isCurated(data: ModelData): boolean {
  const authored = splitModelData(data).authored as Record<string, unknown>;
  delete authored.ignored;
  return Object.keys(authored).length > 0;
}

export function prune(modelsDir: string): string[] {
  const index = buildIndex(modelsDir);
  const removed: string[] = [];

  for (const entry of Object.values(index)) {
    if ((entry.data.providers ?? []).length > 0) continue;
    if (isCurated(entry.data)) continue;
    writeSplit(entry.modelsDir, entry.relativeId, {});
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
export interface Options {
  providerConfigByModel?: Map<string, Record<string, JsonValue>>;
  managedProviderConfigKeys?: string[];
}

export interface Result {
  added: string[];
  removed: string[];
  updated: string[];
}

export function sync(
  modelsDir: string,
  providerName: string,
  modelMap: Map<string, string>,
  options: Options = {},
): Result {
  const index = buildIndex(modelsDir);
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
        if (isMeaningfulSuffix && !hasVersionSuffix(base, numericSuffix)) {
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
      persist(parent.entry, parent.entry.data);
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
    const name = upstream(entry.data, providerName, entry.id);
    if (name && modelUpstreams.has(name)) return true;
    const aliases = entry.data.aliases || [];
    return aliases.some((alias) => modelMap.has(alias) || modelUpstreams.has(alias));
  }

  function findExistingEntry(modelKey: string, upstreamName: string): ModelIndexEntry | null {
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
    if (entryMatchesProviderMap(entry)) continue;

    entry.data.providers = providers.filter((provider) => provider !== providerName);

    if (entry.data.providerConfig?.[providerName]) {
      delete entry.data.providerConfig[providerName];
      if (Object.keys(entry.data.providerConfig).length === 0) {
        delete entry.data.providerConfig;
      }
    }

    persist(entry, entry.data);
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
        persist(existing, existing.data);
        updated.push(modelKey);
      }
    } else {
      const folder = inferModelFolder(modelKey);
      const filePath = folder
        ? join(modelsDir, folder, `${modelKey}${MODEL_EXT}`)
        : join(modelsDir, `${modelKey}${MODEL_EXT}`);
      if (folder) {
        const folderPath = join(modelsDir, folder);
        if (!existsSync(folderPath)) mkdirSync(folderPath, { recursive: true });
      }

      // If a file with the same canonical name already exists (e.g. as a
      // legacy/ignored catch-all), merge providers/providerConfig into the
      // existing file instead of overwriting it. The existing meta/aliases/
      // ignored flags are preserved.
      if (existsSync(filePath)) {
        const existing = read(readFileSync(filePath, "utf-8"));
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
          persist({ modelsDir, relativeId: folder ? `${folder}/${modelKey}` : modelKey }, existing);
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

      persist({ modelsDir, relativeId: folder ? `${folder}/${modelKey}` : modelKey }, data);
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
