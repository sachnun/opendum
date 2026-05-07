import tailwindcss from "@tailwindcss/vite";

const redisXxhashStub = "\0redis-xxhash-stub";

const nitroPreset = process.env.NITRO_PRESET;

type RollupWarning = { code?: string; message?: string };
type RollupWarn = (warning: unknown) => void;

function ignoreKnownSourcemapWarnings(warning: RollupWarning, warn: RollupWarn): void {
  if (
    warning.code === "SOURCEMAP_BROKEN" ||
    warning.message?.includes("Sourcemap is likely to be incorrect")
  ) {
    return;
  }

  warn(warning);
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
      ],
    },
    experimental: {
      tasks: true,
    },
    scheduledTasks: {
      "0 */6 * * *": ["refresh-tokens"],
    },
  },
  vite: {
    build: {
      cssMinify: "lightningcss",
      reportCompressedSize: false,
      rollupOptions: {
        onwarn: ignoreKnownSourcemapWarnings,
      },
      sourcemap: false,
    },
    esbuild: {
      legalComments: "none",
    },
    plugins: [tailwindcss()],
  },
  hooks: {
    "vite:extendConfig"(config) {
      config.build ??= {};
      config.build.sourcemap = false;
      config.build.reportCompressedSize = false;
      config.build.rollupOptions ??= {};
      config.build.rollupOptions.onwarn = ignoreKnownSourcemapWarnings;
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
});
