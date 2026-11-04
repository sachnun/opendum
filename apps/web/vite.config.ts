import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "~": new URL("./src", import.meta.url).pathname,
    },
  },
  server: {
    port: 3000,
  },
  build: {
    target: "esnext",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "solid", test: /node_modules[\\/](solid-js|@solidjs)[\\/]/ },
            { name: "ark", test: /node_modules[\\/](@ark-ui|@zag-js|@internationalized)[\\/]/ },
            { name: "effect", test: /node_modules[\\/]effect[\\/]/ },
            { name: "vendor", test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
});
