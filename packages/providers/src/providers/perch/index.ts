import type { ProviderExtension } from "#providers/extension/types.ts";
import { PerchProvider } from "#providers/providers/perch/provider.ts";

export const extension: ProviderExtension = {
  name: "perch",
  create: (deps) => new PerchProvider({ registry: deps.registry, transport: deps.transport }),
};
