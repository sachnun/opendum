import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";

const redisXxhashStub = "\0redis-xxhash-stub";
const modelRegistryVirtualModule = "virtual:opendum-model-registry";
const modelRegistryVirtualModuleId = `\0${modelRegistryVirtualModule}`;
function collectModelFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return collectModelFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  }).sort((a, b) => a.localeCompare(b));
}

function buildModelRegistryModule(): string {
  const modelsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../models");
  const modelFiles = collectModelFiles(modelsDir);
  const imports = modelFiles.map((filePath, index) => `import model${index} from ${JSON.stringify(filePath)};`);
  const entries = modelFiles.map((filePath, index) => `  ${JSON.stringify(basename(filePath, ".json"))}: model${index},`);

  return [
    ...imports,
    "",
    "const RAW_MODEL_REGISTRY = {",
    ...entries,
    "};",
    "",
    "function mergeModelInfo(modelId, fileId, info, registry) {",
    "  const next = { ...info, id: info.id || modelId };",
    "  if (fileId !== modelId) next.aliases = Array.from(new Set([...(next.aliases || []), fileId])).sort((a, b) => a.localeCompare(b));",
    "  const existing = registry[modelId];",
    "  if (!existing) { registry[modelId] = next; return; }",
    "  registry[modelId] = {",
    "    ...existing,",
    "    ...next,",
    "    id: modelId,",
    "    providers: Array.from(new Set([...(existing.providers || []), ...(next.providers || [])])).sort((a, b) => a.localeCompare(b)),",
    "    aliases: Array.from(new Set([...(existing.aliases || []), ...(next.aliases || [])])).sort((a, b) => a.localeCompare(b)),",
    "    description: existing.description || next.description,",
    "    family: existing.family || next.family,",
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

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  sourcemap: false,
  modules: ["@nuxt/eslint", "@nuxt/fonts"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: process.env.NODE_ENV !== "production" },
  routeRules: {
    "/dashboard": { ssr: false },
    "/dashboard/**": { ssr: false },
  },
  runtimeConfig: {
    proxyUrl: "",
    public: {
      proxyUrl: "",
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
        "lucide-vue-next",
        "reka-ui",
        "tailwind-merge",
      ],
    },
    esbuild: {
      legalComments: "none",
    },
    plugins: [tailwindcss()],
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
