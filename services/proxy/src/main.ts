import { loadEnv, loadEnvFile } from "@opendum/config";
import { serve } from "h3";
import { toProxyConfig } from "./config.js";
import { createContext, disposeContext } from "./context.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  loadEnvFile(".env");
  loadEnvFile("services/proxy/.env");

  const env = loadEnv();
  const config = toProxyConfig(env);
  const context = await createContext(config);
  const app = createServer(context);
  const server = serve(app, { hostname: config.host, port: config.port });

  const refreshController = new AbortController();
  if (config.tokenRefreshIntervalMs > 0) {
    void context.service.startTokenRefresher(refreshController.signal, config.tokenRefreshIntervalMs);
  }

  console.log(`Opendum proxy listening on ${config.host}:${config.port}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
    refreshController.abort();
    void disposeContext(context).finally(() => {
      server.close();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("proxy failed to start", error);
  process.exit(1);
});
