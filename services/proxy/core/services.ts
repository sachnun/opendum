import { Context } from "effect";
import type { AuthService } from "@opendum/auth";
import type { OpendumRedis } from "@opendum/core/redis";
import type { Registry } from "@opendum/models/runtime";
import type { Fetch, UnroxyEgress } from "@opendum/core/egress";
import type { ProviderRegistry } from "@opendum/providers";
import type { ProxyConfig } from "../config.js";
import type { ProxyService } from "./service.js";

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
