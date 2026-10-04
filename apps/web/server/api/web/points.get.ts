import { claimDailyAccessPoints, getUserPointStatus } from "~~/server/services/points";
import { requireReadContext } from "~~/server/utils/api";

export default defineEventHandler(async (event) => {
  const context = await requireReadContext(event);
  try {
    await claimDailyAccessPoints(context.actor.id);
  } catch (error) {
    console.error("Failed to claim daily access points:", error);
  }

  return getUserPointStatus(context.userId);
});
