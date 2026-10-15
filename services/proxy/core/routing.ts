import { preferSticky } from "@opendum/core/redis";
import type { ProviderAccount } from "@opendum/providers";
import type { ProviderRoutingOptions } from "./provider-performance.js";
import { isSyntheticProviderAccountId, prioritizeAccounts } from "./service-helpers.js";

/** Inputs shared by the routing strategies for one account-selection pass. */
export type RoutingContext = {
  /** True when no explicit provider was requested, so providers compete. */
  crossProvider: boolean;
  /** Provider priority order derived from the model registry. */
  providerPriority: string[];
  /** EWMA score snapshot; only present for cross-provider routing. */
  routingOptions?: ProviderRoutingOptions;
};

/** Orders candidates that already passed the eligibility filters. */
export interface RoutingStrategy {
  order(candidates: ProviderAccount[], context: RoutingContext): ProviderAccount[];
}

/**
 * Groups cross-provider candidates into provider-priority order with paid
 * accounts first inside each group; EWMA scores decide which provider takes
 * the head slot when `routingOptions` is present.
 */
export class PriorityOrderStrategy implements RoutingStrategy {
  order(candidates: ProviderAccount[], context: RoutingContext): ProviderAccount[] {
    return prioritizeAccounts(candidates, context.crossProvider, context.providerPriority, context.routingOptions);
  }
}

/** Moves the session-affine account back to the front when it is still a candidate. */
export class StickySessionStrategy implements RoutingStrategy {
  private readonly stickyAccountId: string | null;

  constructor(stickyAccountId: string | null) {
    this.stickyAccountId = stickyAccountId;
  }

  order(candidates: ProviderAccount[]): ProviderAccount[] {
    const stickyAccountId = this.stickyAccountId;
    if (!stickyAccountId || isSyntheticProviderAccountId(stickyAccountId)) return candidates;
    return preferSticky(candidates, (account) => account.id === stickyAccountId);
  }
}

/** Runs each strategy in order, feeding the previous result into the next. */
export function composeRoutingStrategies(...strategies: RoutingStrategy[]): RoutingStrategy {
  return {
    order: (candidates, context) =>
      strategies.reduce((ordered, strategy) => strategy.order(ordered, context), candidates),
  };
}
