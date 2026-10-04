import type { ProviderExtension } from "#providers/extension/types.ts";
import { WorkersAiProvider } from "#providers/providers/workers-ai/provider.ts";

export const extension: ProviderExtension = {
  name: "workers_ai",
  create: (deps) => new WorkersAiProvider({ registry: deps.registry, transport: deps.transport }),
};
