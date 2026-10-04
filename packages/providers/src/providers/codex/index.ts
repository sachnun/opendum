import type { ProviderExtension } from "../../extension/types.js";
import { CodexProvider } from "../../codex.js";

export const extension: ProviderExtension = {
  name: "codex",
  create: (deps) =>
    new CodexProvider({ registry: deps.registry, transport: deps.transport, redis: deps.redis }),
};
