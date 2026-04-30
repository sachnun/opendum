import tailwindcss from "@tailwindcss/vite";

const nitroPreset = process.env.NITRO_PRESET;

export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
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
    commonJS: {
      ignoreTryCatch: true,
    },
    rollupConfig: {
      external: ["pg-native"],
    },
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      "0 */6 * * *": ["refresh-tokens"],
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
