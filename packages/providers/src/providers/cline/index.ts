import type { ProviderExtension } from "../../extension/types.js";
import { ClineProvider } from "../../cline.js";

export const extension: ProviderExtension = {
  name: "cline",
  create: (deps) => new ClineProvider({ registry: deps.registry, transport: deps.transport }),
};
