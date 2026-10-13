import { loadEnv, loadEnvFile } from "@opendum/core/config";
import type { H3 } from "h3";
import { toProxyConfig } from "../src/config.js";
import { createContext, disposeContext, type ProxyContext } from "../src/context.js";
import { createServer } from "../src/server.js";

let context: ProxyContext | undefined;
let appPromise: Promise<H3> | undefined;
let refreshController: AbortController | undefined;

async function initialize(): Promise<H3> {
  loadEnvFile(".env");
  loadEnvFile("services/proxy/.env");

  const env = loadEnv();
  const config = toProxyConfig(env);
  const created = await createContext(config);
  context = created;

  if (config.tokenRefreshIntervalMs > 0) {
    refreshController = new AbortController();
    void created.service.startTokenRefresher(refreshController.signal, config.tokenRefreshIntervalMs);
  }

  return createServer(created);
}

export function proxyApp(): Promise<H3> {
  appPromise ??= initialize();
  return appPromise;
}

export async function disposeProxyContext(): Promise<void> {
  refreshController?.abort();
  refreshController = undefined;
  if (appPromise) {
    await appPromise.catch(() => undefined);
  }
  const current = context;
  context = undefined;
  if (current) {
    await disposeContext(current);
  }
}
