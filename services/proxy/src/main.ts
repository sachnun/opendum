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
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down`);
    refreshController.abort();
    const forced = setTimeout(() => {
      void server.close(true);
    }, 15_000);
    forced.unref?.();
    try {
      await server.close();
    } catch {
      // the server is already closing
    } finally {
      clearTimeout(forced);
    }
    await disposeContext(context);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("proxy failed to start", error);
  process.exit(1);
});
