import tailwindcss from "@tailwindcss/vite";

const redisXxhashStub = "\0redis-xxhash-stub";

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
