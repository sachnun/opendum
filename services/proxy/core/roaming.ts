import type { PointPort } from "./repositories.js";
import type { Registry } from "@opendum/models/runtime";
import {
  refundRoamingPoint,
  reserveRoamingPoint,
  settleRoamingPoint,
  type PointReservation,
} from "./points.js";
import type { UsageCounts } from "./types.js";

/**
 * Owns the roaming-points lifecycle (reserve → settle/refund). Reserve
 * surfaces its result (null means insufficient points); settle and refund
 * propagate failures so callers decide how to react (ProxyService wraps
 * best-effort settlement in `ignore`).
 */
export class Roaming {
  constructor(
    private readonly points: PointPort,
    private readonly models: Registry
  ) {}

  reserve(userId: string, model: string): Promise<PointReservation | null> {
    return reserveRoamingPoint(this.points, userId, model);
  }

  async settle(
    ownerUserId: string,
    reservation: PointReservation,
    model: string,
    usage: UsageCounts
  ): Promise<void> {
    await settleRoamingPoint(this.points, this.models, ownerUserId, reservation, model, usage);
  }

  async refund(reservation: PointReservation): Promise<void> {
    await refundRoamingPoint(this.points, reservation);
  }
}
