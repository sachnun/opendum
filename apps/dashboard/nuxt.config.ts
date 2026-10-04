import type { Plugin } from "vite";
import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { inferFamilyFromFolder } from "@opendum/models/families";
import { collectModelFiles } from "@opendum/models/registry";

const redisXxhashStub = "\0redis-xxhash-stub";
const modelRegistryVirtualModule = "virtual:opendum-model-registry";
const modelRegistryVirtualModuleId = `\0${modelRegistryVirtualModule}`;
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
        result[basename(fullPath, ".json")] = inferFamilyFromFolder(basename(dir));
      }
    }
  }
  walk(modelsDir);
  return result;
}

function buildModelRegistryModule(): string {
  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/models/data");
  const generatedDir = resolve(dataDir, "../generated");
  const authoredFiles = collectModelFiles(dataDir);
  const generatedFiles = collectModelFiles(generatedDir);
  const familyByFileId = collectFamilyByFileId(dataDir);
  const imports: string[] = [];
  const entries: string[] = [];
  const byFileId = new Map<string, { authored?: string; generated?: string }>();

  for (const filePath of authoredFiles) {
    const fileId = basename(filePath, ".json");
    byFileId.set(fileId, { ...(byFileId.get(fileId) ?? {}), authored: filePath });
  }
  for (const filePath of generatedFiles) {
    const fileId = basename(filePath, ".json");
    byFileId.set(fileId, { ...(byFileId.get(fileId) ?? {}), generated: filePath });
  }

  let index = 0;
  for (const [fileId, halves] of [...byFileId].sort(([a], [b]) => a.localeCompare(b))) {
    const authoredVar = halves.authored ? `model${index++}` : null;
    const generatedVar = halves.generated ? `model${index++}` : null;
    if (halves.authored && authoredVar) imports.push(`import ${authoredVar} from ${JSON.stringify(halves.authored)};`);
    if (halves.generated && generatedVar) imports.push(`import ${generatedVar} from ${JSON.stringify(halves.generated)};`);
    entries.push(`  ${JSON.stringify(fileId)}: { authored: ${authoredVar ?? "null"}, generated: ${generatedVar ?? "null"} },`);
  }

  return [
    ...imports,
    'import { mergeModelData } from "@opendum/models/merge";',
    "",
    "const RAW_MODEL_REGISTRY = {",
    ...entries,
    "};",
    "",
    "const FOLDER_FAMILY = " + JSON.stringify(familyByFileId) + ";",
    "",
    REGISTRY_HELPERS,
    "",
    "export const MODEL_REGISTRY = {};",
    "for (const [fileId, halves] of Object.entries(RAW_MODEL_REGISTRY)) {",
    "  const info = mergeModelData(halves.generated, halves.authored);",
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

const REGISTRY_HELPERS = [
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
  "    reasoning: existing.reasoning ?? next.reasoning,",
  "    modalities: existing.modalities || next.modalities,",
  "    providerConfig: { ...(existing.providerConfig || {}), ...(next.providerConfig || {}) },",
  "  };",
  "}",
].join("\n");

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  ssr: false,
  sourcemap: false,
  modules: ["@nuxt/a11y", "@nuxt/eslint", "@nuxt/fonts"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: process.env.NODE_ENV !== "production" },
  spaLoadingTemplate: "./loading.html",
  experimental: {
    spaLoadingTemplateLocation: "within",
  },
  runtimeConfig: {
    proxyUrl: "",
    public: {
      proxyUrl: "",
      authOauthEmulator: process.env.AUTH_OAUTH_EMULATOR === "1",
    },
  },
  fonts: {
    defaults: {
      styles: ["normal"],
      subsets: ["latin"],
      weights: [400, 500, 600, 700],
    },
    families: [
      { name: "Geist", preload: true },
      { name: "Geist Mono", preload: false },
    ],
  },
  nitro: {
    commonJS: {
      ignoreTryCatch: true,
    },
    rollupConfig: {
      external: ["pg-native"],
      plugins: [
        {
          name: "redis-xxhash-stub",
          resolveId(id) {
            return id === "@node-rs/xxhash" ? redisXxhashStub : null;
          },
          load(id) {
            if (id !== redisXxhashStub) return null;
            return "export const xxh3 = { xxh64() { throw new Error('Redis digest commands are not supported in this build.'); } };";
          },
        },
        {
          name: "opendum-model-registry",
          resolveId(id) {
            return id === modelRegistryVirtualModule ? modelRegistryVirtualModuleId : null;
          },
          load(id) {
            return id === modelRegistryVirtualModuleId ? buildModelRegistryModule() : null;
          },
        },
      ],
    },
  },
  vite: {
    build: {
      cssMinify: "lightningcss",
      reportCompressedSize: false,
      sourcemap: false,
    },
    optimizeDeps: {
      include: [
        "@internationalized/date",
        "@vue/devtools-core",
        "@vue/devtools-kit",
        "better-auth/vue",
        "clsx",
        "date-fns",
        "idb-keyval",
        "@lucide/vue",
        "reka-ui",
        "tailwind-merge",
      ],
    },
    esbuild: {
      legalComments: "none",
    },
    plugins: [tailwindcss() as unknown as Plugin],
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
