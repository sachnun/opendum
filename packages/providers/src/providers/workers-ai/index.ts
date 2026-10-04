import type { ProviderExtension } from "../../extension/types.js";
import { WorkersAiProvider } from "../../workers-ai.js";

export const extension: ProviderExtension = {
  name: "workers_ai",
  create: (deps) => new WorkersAiProvider({ registry: deps.registry, transport: deps.transport }),
};
