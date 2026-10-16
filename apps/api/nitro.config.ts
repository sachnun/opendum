import { fileURLToPath } from "node:url";
import { defineConfig } from "nitro";

export default defineConfig({
  preset: "bun",
  serverDir: "./",
  serverEntry: false,
  builder: "rollup",
  alias: {
    "#web": fileURLToPath(new URL("./web", import.meta.url)),
  },
  routeRules: {
    "/**": {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowHeaders: "*",
        exposeHeaders: "*",
      },
    },
    "/": { redirect: { to: "/v1", status: 308 } },
  },
  devServer: {
    hostname: "localhost",
    port: 4001,
  },
});
