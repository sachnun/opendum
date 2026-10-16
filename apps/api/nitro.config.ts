import { defineConfig } from "nitro";

export default defineConfig({
  preset: "bun",
  serverDir: "./",
  serverEntry: false,
  builder: "rollup",
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
    hostname: "127.0.0.1",
    port: 4001,
  },
});
