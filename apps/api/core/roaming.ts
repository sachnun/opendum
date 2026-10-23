import { Effect } from "effect";
import type { PointPort } from "./repositories.js";
import type { Registry } from "@opendum/models/runtime";
import {
  refundRoamingPoint,
  reserveRoamingPoint,
  settleRoamingPoint,
  type PointReservation,
} from "./points.js";
import type { UsageCounts } from "./types.js";

export class Roaming {
  constructor(
    private readonly points: PointPort,
    private readonly models: Registry
  ) {}

  reserve(userId: string, model: string): Effect.Effect<PointReservation | null> {
    return Effect.promise(() => reserveRoamingPoint(this.points, userId, model));
  }

  settle(
    ownerUserId: string,
    reservation: PointReservation,
    model: string,
    usage: UsageCounts
  ): Effect.Effect<void> {
    return Effect.promise(() =>
      settleRoamingPoint(this.points, this.models, ownerUserId, reservation, model, usage)
    );
  }

  refund(reservation: PointReservation): Effect.Effect<void> {
    return Effect.promise(() => refundRoamingPoint(this.points, reservation));
  }
}
