import { loadConfig } from "./config.js";
import { serve } from "@hono/node-server";
import { createApp } from "./index.js";

const cfg = loadConfig();
const { app, redis } = createApp();

setInterval(() => {
  // token refresh scan runs on demand; periodic scan is a no-op placeholder
}, 0);

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Opendum proxy listening on http://${cfg.host}:${info.port}`);
});

process.on("SIGINT", () => {
  redis?.disconnect();
  process.exit(0);
});
