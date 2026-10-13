import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { loadModelEntries } from "@opendum/models/runtime";

const modelRegistryVirtualModule = "virtual:opendum-model-registry";

function buildModelRegistryModule(): string {
  const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/models/data");
  const entries = loadModelEntries(dataDir);
  return `export const MODEL_ENTRIES = ${JSON.stringify(entries)};`;
}

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  ssr: false,
  sourcemap: false,
  modules: ["@nuxt/a11y", "@nuxt/fonts"],
  css: ["~/assets/css/main.css"],
  components: [{ path: "~/components", pathPrefix: false }],
  devtools: { enabled: process.env.NODE_ENV !== "production" },
  spaLoadingTemplate: "./loading.html",
  experimental: {
    spaLoadingTemplateLocation: "within",
    nitroAutoImports: true,
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
    virtual: {
      [modelRegistryVirtualModule]: () => buildModelRegistryModule(),
    },
  },
  vite: {
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
    plugins: [tailwindcss() as never],
  },
  typescript: {
    strict: true,
    typeCheck: false,
    serverTsConfig: {
      compilerOptions: {
        paths: {
          "~~": [".."],
          "~~/*": ["../*"],
        },
      },
    },
  },
});
