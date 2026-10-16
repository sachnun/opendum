import tailwindcss from "@tailwindcss/vite";

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
      apiUrl: "",
    },
  },
  nitro: {
    prerender: {
      autoSubfolderIndex: false,
      ignore: ["/404.html"],
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
  vite: {    optimizeDeps: {
      include: [
        "@internationalized/date",
        "@vue/devtools-core",
        "@vue/devtools-kit",
        "better-auth/vue",
        "clsx",
        "date-fns",
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
  },
});
