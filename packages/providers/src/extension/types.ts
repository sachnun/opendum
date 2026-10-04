import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import type { FallbackState } from "#providers/lib/fallback.ts";
import type { Logger, MutableTransport } from "#providers/api/http.ts";
import type { Provider } from "#providers/model/types.ts";

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
