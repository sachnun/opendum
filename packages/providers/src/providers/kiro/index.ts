import type { ProviderExtension } from "#providers/extension/types.ts";
import { KiroProvider } from "#providers/providers/kiro/provider.ts";

export const extension: ProviderExtension = {
  name: "kiro",
  create: (deps) => new KiroProvider({ registry: deps.registry, transport: deps.transport }),
};
