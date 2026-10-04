import type { ProviderExtension } from "../../extension/types.js";
import { WorkbuddyProvider } from "../../workbuddy.js";

export const extension: ProviderExtension = {
  name: "workbuddy",
  create: (deps) => new WorkbuddyProvider({ registry: deps.registry, transport: deps.transport }),
};
