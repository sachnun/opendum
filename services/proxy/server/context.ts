import { loadEnv, loadEnvFile } from "@opendum/core/config";
import { toProxyConfig } from "../src/config.js";
import { createContext, disposeContext, type ProxyContext } from "../src/context.js";

let contextPromise: Promise<ProxyContext> | undefined;
let refreshController: AbortController | undefined;

async function initialize(): Promise<ProxyContext> {
  loadEnvFile(".env");
  loadEnvFile("services/proxy/.env");

  const env = loadEnv();
  const config = toProxyConfig(env);
  const context = await createContext(config);

  if (config.tokenRefreshIntervalMs > 0) {
    refreshController = new AbortController();
    void context.service.startTokenRefresher(refreshController.signal, config.tokenRefreshIntervalMs);
  }

  return context;
}

export function getProxyContext(): Promise<ProxyContext> {
  contextPromise ??= initialize();
  return contextPromise;
}

export async function disposeProxyContext(): Promise<void> {
  refreshController?.abort();
  refreshController = undefined;
  const pending = contextPromise;
  contextPromise = undefined;
  if (!pending) return;
  const context = await pending.catch(() => undefined);
  if (context) await disposeContext(context);
}
