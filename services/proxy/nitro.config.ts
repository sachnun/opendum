import { defineConfig } from "nitro";

export default defineConfig({
  preset: "bun",
  serverDir: "server",
  serverEntry: false,
  builder: "rollup",
  devServer: {
    hostname: "127.0.0.1",
    port: 4001,
  },
});
