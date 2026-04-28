export default defineNuxtConfig({
  compatibilityDate: "2025-07-15",
  modules: ["@nuxt/ui", "@nuxt/eslint"],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: process.env.NODE_ENV !== "production" },
  runtimeConfig: {
    public: {
      proxyUrl: "",
    },
  },
  ui: {
    colorMode: false,
    theme: {
      defaultVariants: {
        color: "neutral",
      },
    },
  },
  fonts: {
    defaults: {
      weights: [400, 500, 600, 700],
    },
  },
  icon: {
    serverBundle: {
      collections: ["lucide"],
    },
  },
  nitro: {
    preset: process.env.NITRO_PRESET,
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
