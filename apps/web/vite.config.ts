import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { opendumModelRegistryPlugin } from "@opendum/shared/registry";

export default defineConfig({
  plugins: [react(), tailwindcss(), opendumModelRegistryPlugin()],
  server: {
    proxy: {
      "/api": {
        target: process.env.API_URL ?? "http://localhost:3001",
        changeOrigin: true,
      },
      "/v1": {
        target: process.env.PROXY_URL ?? "http://localhost:4001",
        changeOrigin: true,
      },
    },
  },
  build: {
    cssMinify: "lightningcss",
    reportCompressedSize: false,
    sourcemap: false,
  },
});
