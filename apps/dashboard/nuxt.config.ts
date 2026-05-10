import tailwindcss from "@tailwindcss/vite";

const redisXxhashStub = "\0redis-xxhash-stub";
const nitroPreset = process.env.NITRO_PRESET;

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
