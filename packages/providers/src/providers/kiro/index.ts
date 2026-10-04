import type { ProviderExtension } from "../../extension/types.js";
import { KiroProvider } from "../../kiro.js";

export const extension: ProviderExtension = {
  name: "kiro",
  create: (deps) => new KiroProvider({ registry: deps.registry, transport: deps.transport }),
};
