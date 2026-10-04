import type { ProviderExtension } from "#providers/extension/types.ts";
import { WorkbuddyProvider } from "#providers/providers/workbuddy/provider.ts";

export const extension: ProviderExtension = {
  name: "workbuddy",
  create: (deps) => new WorkbuddyProvider({ registry: deps.registry, transport: deps.transport }),
};
