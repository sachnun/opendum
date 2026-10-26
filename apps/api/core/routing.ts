import { preferSticky } from "@opendum/core/redis";
import type { ProviderAccount } from "@opendum/providers";
import type { ProviderRoutingOptions } from "@opendum/api/core/provider-performance";
import { isSynthetic, prioritizeAccounts } from "@opendum/api/core/service-helpers";

export type Context = {
  crossProvider: boolean;
  priority: string[];
  routingOptions?: ProviderRoutingOptions;
};

export interface Strategy {
  order(candidates: ProviderAccount[], context: Context): ProviderAccount[];
}

export class Priority implements Strategy {
  order(candidates: ProviderAccount[], context: Context): ProviderAccount[] {
    return prioritizeAccounts(candidates, context.crossProvider, context.priority, context.routingOptions);
  }
}

export class Sticky implements Strategy {
  private readonly accountId: string | null;

  constructor(accountId: string | null) {
    this.accountId = accountId;
  }

  order(candidates: ProviderAccount[]): ProviderAccount[] {
    const accountId = this.accountId;
    if (!accountId || isSynthetic(accountId)) return candidates;
    return preferSticky(candidates, (account) => account.id === accountId);
  }
}

export function compose(...strategies: Strategy[]): Strategy {
  return {
    order: (candidates, context) =>
      strategies.reduce((ordered, strategy) => strategy.order(ordered, context), candidates),
  };
}
