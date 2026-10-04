import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import type { FallbackState } from "../fallback.js";
import type { Logger, MutableTransport } from "../http.js";
import type { Provider } from "../types.js";

export type ProviderDeps = {
  registry: Registry;
  transport: MutableTransport;
  fallback: FallbackState | null;
  redis: OpendumRedis | null;
  logger?: Logger;
};

export interface ProviderExtension {
  readonly name: string;
  readonly order?: number;
  create(deps: ProviderDeps): Provider;
}
