import { defineHandler } from "nitro";
import { claimDailyAccessPoints, getUserPointStatus } from "#web/services/points.js";
import { requireReadContext } from "#web/utils/api.js";

export default defineHandler(async (event) => {
  const context = await requireReadContext(event);
  try {
    await claimDailyAccessPoints(context.actor.id);
  } catch (error) {
    console.error("Failed to claim daily access points:", error);
  }

  return getUserPointStatus(context.userId);
});
