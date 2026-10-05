import type { ProviderExtension } from "#providers/extension/types.ts";
import { ClineProvider } from "#providers/providers/cline/provider.ts";

export const extension: ProviderExtension = {
  name: "cline",
  create: (deps) => new ClineProvider({ registry: deps.registry, transport: deps.transport }),
};
