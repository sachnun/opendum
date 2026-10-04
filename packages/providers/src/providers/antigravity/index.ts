import type { ProviderExtension } from "#providers/extension/types.ts";
import { AntigravityProvider } from "#providers/providers/antigravity/provider.ts";

export const extension: ProviderExtension = {
  name: "antigravity",
  create: (deps) =>
    new AntigravityProvider({ registry: deps.registry, transport: deps.transport, redis: deps.redis }),
};
