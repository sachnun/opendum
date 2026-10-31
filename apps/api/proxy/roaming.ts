import { Effect } from "effect";
import type { PointPort } from "@opendum/api/proxy/repositories";
import type { Registry } from "@opendum/models/runtime";
import {
  refundRoamingPoint,
  reserveRoamingPoint,
  settleRoamingPoint,
  type PointReservation,
} from "@opendum/api/proxy/points";
import type { UsageCounts } from "@opendum/api/proxy/types";

export class Roaming {
  constructor(
    private readonly points: PointPort,
    private readonly models: Registry
  ) {}

  reserve(userId: string, model: string) {
    return reserveRoamingPoint(this.points, userId, model).pipe(
      Effect.mapError((failure) => new Error(failure.message))
    );
  }

  settle(
    ownerUserId: string,
    reservation: PointReservation,
    model: string,
    usage: UsageCounts
  ) {
    return settleRoamingPoint(this.points, this.models, ownerUserId, reservation, model, usage).pipe(
      Effect.mapError((failure) => new Error(failure.message))
    );
  }

  refund(reservation: PointReservation) {
    return refundRoamingPoint(this.points, reservation).pipe(
      Effect.mapError((failure) => new Error(failure.message))
    );
  }
}
