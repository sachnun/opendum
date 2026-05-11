import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";

const redisXxhashStub = "\0redis-xxhash-stub";
const modelRegistryVirtualModule = "virtual:opendum-model-registry";
const modelRegistryVirtualModuleId = `\0${modelRegistryVirtualModule}`;
const nitroPreset = process.env.NITRO_PRESET;

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
    "export const MODEL_REGISTRY = {",
    ...entries,
    "};",
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
  modules: ["@nuxt/eslint"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: process.env.NODE_ENV !== "production" },
  runtimeConfig: {
    public: {
      proxyUrl: "",
    },
  },
  fonts: {
    defaults: {
      weights: [400, 500, 600, 700],
    },
  },
  nitro: {
    preset: nitroPreset,
    cloudflare: {
      deployConfig: nitroPreset === "cloudflare_module" ? true : undefined,
      nodeCompat: nitroPreset === "cloudflare_module" ? true : undefined,
      wrangler: {
        name: "opendum",
        compatibility_flags: ["nodejs_compat"],
      },
    },
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
