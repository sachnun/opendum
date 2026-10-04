import { discoverModules } from "@opendum/extension";
import type { ProviderExtension } from "./types.js";

export * from "./types.js";
export { discoverModules } from "@opendum/extension";
export type { Discoverable, DiscoverOptions } from "@opendum/extension";

export function discoverProviderExtensions(): Promise<ProviderExtension[]> {
  return discoverModules<ProviderExtension>({
    pattern: "*/index.ts",
    dir: new URL("../providers/", import.meta.url),
  });
}
