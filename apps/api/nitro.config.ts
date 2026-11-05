import { defineConfig } from "nitro";

export default defineConfig({
  preset: "bun",
  serverDir: "./",
  serverEntry: false,
  builder: "rolldown",
  errorHandler: "./error.ts",
  routeRules: {
    "/**": {
      cors: {
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowHeaders: "*",
        exposeHeaders: "*",
        maxAge: "86400",
      },
    },
    "/v1/models": {
      headers: {
        "cache-control": "private, max-age=30, stale-while-revalidate=60",
        vary: "authorization",
      },
    },
    "/v1/**": { headers: { "cache-control": "no-store" } },
    "/health": { headers: { "cache-control": "no-store" } },
    "/rpc/**": { headers: { "cache-control": "no-store" } },
    "/api/auth/**": { headers: { "cache-control": "no-store" } },
    "/": { redirect: { to: "/v1", status: 308 } },
  },
  devServer: {
    hostname: "localhost",
    port: 4001,
  },
});
