import type { ProviderExtension } from "../../extension/types.js";
import { PerchProvider } from "../../perch.js";

export const extension: ProviderExtension = {
  name: "perch",
  create: (deps) => new PerchProvider({ registry: deps.registry, transport: deps.transport }),
};
