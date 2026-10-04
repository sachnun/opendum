import type { ProviderExtension } from "#providers/extension/types.ts";
import { CodexProvider } from "#providers/providers/codex/provider.ts";

export const extension: ProviderExtension = {
  name: "codex",
  create: (deps) =>
    new CodexProvider({ registry: deps.registry, transport: deps.transport, redis: deps.redis }),
};
