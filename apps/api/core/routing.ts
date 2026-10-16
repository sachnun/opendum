import { preferSticky } from "@opendum/core/redis";
import type { ProviderAccount } from "@opendum/providers";
import type { ProviderRoutingOptions } from "./provider-performance.js";
import { isSyntheticProviderAccountId, prioritizeAccounts } from "./service-helpers.js";

/** Inputs shared by the routing strategies for one account-selection pass. */
export type Context = {
  /** True when no explicit provider was requested, so providers compete. */
  crossProvider: boolean;
  /** Provider priority order derived from the model registry. */
  priority: string[];
  /** EWMA score snapshot; only present for cross-provider routing. */
  routingOptions?: ProviderRoutingOptions;
};

/** Orders candidates that already passed the eligibility filters. */
export interface Strategy {
  order(candidates: ProviderAccount[], context: Context): ProviderAccount[];
}

/**
 * Groups cross-provider candidates into provider-priority order with paid
 * accounts first inside each group; EWMA scores decide which provider takes
 * the head slot when `routingOptions` is present.
 */
export class Priority implements Strategy {
  order(candidates: ProviderAccount[], context: Context): ProviderAccount[] {
    return prioritizeAccounts(candidates, context.crossProvider, context.priority, context.routingOptions);
  }
}

/** Moves the session-affine account back to the front when it is still a candidate. */
export class Sticky implements Strategy {
  private readonly accountId: string | null;

  constructor(accountId: string | null) {
    this.accountId = accountId;
  }

  order(candidates: ProviderAccount[]): ProviderAccount[] {
    const accountId = this.accountId;
    if (!accountId || isSyntheticProviderAccountId(accountId)) return candidates;
    return preferSticky(candidates, (account) => account.id === accountId);
  }
}

/** Runs each strategy in order, feeding the previous result into the next. */
export function compose(...strategies: Strategy[]): Strategy {
  return {
    order: (candidates, context) =>
      strategies.reduce((ordered, strategy) => strategy.order(ordered, context), candidates),
  };
}
