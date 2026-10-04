import { discoverModules } from "@opendum/extension";
import type { QuotaProvider } from "./types.js";

export function discoverQuotaProviders(): Promise<QuotaProvider[]> {
  return discoverModules<QuotaProvider>({
    pattern: "*/index.ts",
    dir: new URL("./providers/", import.meta.url),
    key: "provider",
  });
}
