import { discoverModules } from "@opendum/extension";
import type { ProviderExtension } from "#providers/extension/types.ts";

export * from "#providers/extension/types.ts";
export { discoverModules } from "@opendum/extension";
export type { Discoverable, DiscoverOptions } from "@opendum/extension";

export function discoverProviderExtensions(): Promise<ProviderExtension[]> {
  return discoverModules<ProviderExtension>({
    pattern: "*/index.ts",
    dir: new URL("../providers/", import.meta.url),
  });
}
