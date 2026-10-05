import type { Provider, ProviderAccount } from "@opendum/providers";
import type { StreamRecorder } from "./types.ts";

import { cloneMap, numberAsInt } from "./transport/helpers.ts";
import { adjustRoamingPoints, creditSharingPoint, roamingPoints } from "./metering/points.ts";
import {
  customProviderForAccount as customProviderForAccountImpl,
  quotaCredentials as quotaCredentialsImpl,
  startTokenRefresher as startTokenRefresherImpl,
} from "./service-credentials.ts";
import {
  recordSuccessfulRequest as recordSuccessfulRequestImpl,
  storeHypercreditsUsage as storeHypercreditsUsageImpl,
} from "./health/service-health.ts";
import { ProxyServiceBase, type ProxyServiceOptions } from "./service-handle.ts";

export type { ProxyServiceOptions } from "./service-handle.ts";

export class ProxyService extends ProxyServiceBase implements StreamRecorder {
  constructor(options: ProxyServiceOptions) {
    super(options);
  }

  storeHypercreditsUsage(accountId: string, remaining: number | null, cost: number): void {
    storeHypercreditsUsageImpl(this.deps, accountId, remaining, cost);
  }

  recordSuccessfulRequest(params: {
    accountId: string;
    provider: string;
    model: string;
    userId: string;
    apiKeyId: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    durationMs: number;
    stream: boolean;
    requestStartMs: number;
    upstreamFirstResponseMs: number;
  }): void {
    recordSuccessfulRequestImpl(this.deps, params);
  }

  async quotaCredentials(account: ProviderAccount): Promise<string> {
    return quotaCredentialsImpl(this.deps, account);
  }

  async startTokenRefresher(signal: AbortSignal, intervalMs: number): Promise<void> {
    return startTokenRefresherImpl(this.deps, signal, intervalMs);
  }

  async customProviderForAccount(userId: string, provider: string): Promise<Provider | null> {
    return customProviderForAccountImpl(this.deps, userId, provider);
  }
}

export { extractSessionId } from "./transport/service-helpers.ts";

export { cloneMap, numberAsInt, creditSharingPoint, adjustRoamingPoints, roamingPoints };
