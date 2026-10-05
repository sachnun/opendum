import type { ProviderExtension } from "#providers/extension/types.ts";
import { OpencodeProvider } from "#providers/providers/opencode/provider.ts";

export const extension: ProviderExtension = {
  name: "opencode",
  create: (deps) =>
    new OpencodeProvider({
      registry: deps.registry,
      transport: deps.transport,
      fallback: deps.fallback,
      logger: deps.logger,
    }),
};
