import type { Plugin } from "vite";
import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_REGISTRY_VIRTUAL = "virtual:opendum-model-registry";
const MODEL_REGISTRY_VIRTUAL_ID = `\0${MODEL_REGISTRY_VIRTUAL}`;

function collectModelFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return collectModelFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  }).sort((a, b) => a.localeCompare(b));
}

function collectFamilyByFileId(modelsDir: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        result[basename(fullPath, ".json")] = basename(dir);
      }
    }
  }
  walk(modelsDir);
  return result;
}

export function buildModelRegistryModule(modelsDir: string): string {
  const modelFiles = collectModelFiles(modelsDir);
  const familyByFileId = collectFamilyByFileId(modelsDir);
  const imports = modelFiles.map((filePath, index) => `import model${index} from ${JSON.stringify(filePath)};`);
  const entries = modelFiles.map((filePath, index) => `  ${JSON.stringify(basename(filePath, ".json"))}: model${index},`);

  return [
    ...imports,
    "",
    "const RAW_MODEL_REGISTRY = {",
    ...entries,
    "};",
    "",
    "const FOLDER_FAMILY = " + JSON.stringify(familyByFileId) + ";",
    "",
    "function mergeModelInfo(modelId, fileId, info, registry) {",
    "  const folderFamily = FOLDER_FAMILY[fileId] || null;",
    "  const next = { ...info, id: info.id || modelId };",
    "  if (fileId !== modelId) next.aliases = Array.from(new Set([...(next.aliases || []), fileId])).sort((a, b) => a.localeCompare(b));",
    "  const existing = registry[modelId];",
    "  if (!existing) {",
    "    registry[modelId] = { ...next, family: next.family || folderFamily || undefined };",
    "    return;",
    "  }",
    "  registry[modelId] = {",
    "    ...existing,",
    "    ...next,",
    "    id: modelId,",
    "    providers: Array.from(new Set([...(existing.providers || []), ...(next.providers || [])])).sort((a, b) => a.localeCompare(b)),",
    "    aliases: Array.from(new Set([...(existing.aliases || []), ...(next.aliases || [])])).sort((a, b) => a.localeCompare(b)),",
    "    description: existing.description || next.description,",
    "    family: existing.family || next.family || folderFamily || undefined,",
    "    ignored: Boolean(existing.ignored && next.ignored),",
    "    meta: existing.meta || next.meta,",
    "    providerConfig: { ...(existing.providerConfig || {}), ...(next.providerConfig || {}) },",
    "  };",
    "}",
    "",
    "export const MODEL_REGISTRY = {};",
    "for (const [fileId, info] of Object.entries(RAW_MODEL_REGISTRY)) {",
    "  mergeModelInfo(info.id || fileId, fileId, info, MODEL_REGISTRY);",
    "}",
    "",
    "export const IGNORED_MODELS = new Set(",
    "  Object.entries(MODEL_REGISTRY)",
    "    .filter(([, info]) => info.ignored)",
    "    .map(([modelId]) => modelId)",
    ");",
  ].join("\n");
}

/**
 * Vite plugin exposing the opendum model registry as a virtual module.
 * `modelsDir` resolves to the repo-root `models/` directory.
 */
export function opendumModelRegistryPlugin(options: { modelsDir?: string } = {}): Plugin {
  const modelsDir = options.modelsDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../models");
  return {
    name: "opendum-model-registry",
    resolveId(id) {
      return id === MODEL_REGISTRY_VIRTUAL ? MODEL_REGISTRY_VIRTUAL_ID : null;
    },
    load(id) {
      return id === MODEL_REGISTRY_VIRTUAL_ID ? buildModelRegistryModule(modelsDir) : null;
    },
  };
}
