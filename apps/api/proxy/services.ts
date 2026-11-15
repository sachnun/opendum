import { Context } from "effect";
import type { AuthService } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/platform/redis";
import type { Registry } from "@opendum/models/runtime";
import type { Fetch, UnroxyEgress } from "@opendum/platform/egress";
import type { ProviderRegistry } from "@opendum/providers";
import type { ProxyConfig } from "@opendum/api/config";
import type { ProxyService } from "@opendum/api/proxy/service";

export type ProxyContext = {
  config: ProxyConfig;
  models: Registry;
  redis: OpendumRedis;
  auth: AuthService;
  providers: ProviderRegistry;
  service: ProxyService;
  egress: UnroxyEgress;
  guardedFetch: Fetch;
};

export class ProxyContextTag extends Context.Service<ProxyContextTag, ProxyContext>()(
  "opendum/proxy/ProxyContext"
) {}
