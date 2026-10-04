import type { AuthService } from "@opendum/auth";
import type { Database } from "@opendum/database";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderRegistry } from "@opendum/providers";
import type { OpendumRedis, SessionAffinity } from "@opendum/redis";

import type { ProviderPerformance } from "./provider-performance.js";

export type ProxyDeps = {
  database: Database;
  redis: OpendumRedis;
  models: Registry;
  auth: AuthService;
  providers: ProviderRegistry;
  secret: string;
  requestTimeoutMs: number;
  affinity: SessionAffinity;
  performance: ProviderPerformance;
};
