import type { ProviderExtension } from "../../extension/types.js";
import { OpencodeProvider } from "../../opencode.js";

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
