import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { loadModelEntries } from "@opendum/models/runtime";

const redisXxhashStub = "\0redis-xxhash-stub";
const modelRegistryVirtualModule = "virtual:opendum-model-registry";
const modelRegistryVirtualModuleId = `\0${modelRegistryVirtualModule}`;
const accountConnectorsVirtualModule = "virtual:opendum-provider-connectors";
const accountConnectorsVirtualModuleId = `\0${accountConnectorsVirtualModule}`;

function buildModelRegistryModule(): string {
  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/models/data");
  const entries = loadModelEntries(dataDir);
  return `export const MODEL_ENTRIES = ${JSON.stringify(entries)};`;
}

function buildAccountConnectorsModule(): string {
  const providersDir = resolve(dirname(fileURLToPath(import.meta.url)), "server/lib/providers");
  const names = readdirSync(providersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(providersDir, entry.name, "index.ts")))
    .map((entry) => entry.name)
    .sort();
  const imports = names.map(
    (name, index) => `import { connector as c${index} } from ${JSON.stringify(join(providersDir, name, "index.ts"))};`
  );
  const entries = names.map((name, index) => `${JSON.stringify(name)}: c${index}`);
  return `${imports.join("\n")}\nexport const PROVIDER_CONNECTORS = { ${entries.join(", ")} };`;
}

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  ssr: false,
  sourcemap: false,
  modules: ["@nuxt/a11y", "@nuxt/eslint", "@nuxt/fonts"],
  css: ["~/assets/css/main.css"],
  components: [{ path: "~/components", pathPrefix: false }],
  devtools: { enabled: process.env.NODE_ENV !== "production" },
  spaLoadingTemplate: "./loading.html",
  experimental: {
    spaLoadingTemplateLocation: "within",
  },
  runtimeConfig: {
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
        {
          name: "opendum-provider-connectors",
          resolveId(id) {
            return id === accountConnectorsVirtualModule ? accountConnectorsVirtualModuleId : null;
          },
          load(id) {
            return id === accountConnectorsVirtualModuleId ? buildAccountConnectorsModule() : null;
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
    plugins: [tailwindcss() as never],
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
