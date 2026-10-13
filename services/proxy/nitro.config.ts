import { defineConfig } from "nitro";

export default defineConfig({
  preset: "bun",
  serverEntry: "nitro/server-entry.ts",
  plugins: ["nitro/plugin.ts"],
  devServer: {
    hostname: "127.0.0.1",
    port: 4001,
  },
});
