import type { ProviderExtension } from "../../extension/types.js";
import { AntigravityProvider } from "../../antigravity.js";

export const extension: ProviderExtension = {
  name: "antigravity",
  create: (deps) =>
    new AntigravityProvider({ registry: deps.registry, transport: deps.transport, redis: deps.redis }),
};
