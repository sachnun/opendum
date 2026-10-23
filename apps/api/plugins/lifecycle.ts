import { definePlugin } from "nitro";
import { disposeProxyContext } from "../context.js";
import { pendingTaskCount, settlePendingTasks } from "../core/pending.js";

const DRAIN_TIMEOUT_MS = 4_000;

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    const drained = await settlePendingTasks(DRAIN_TIMEOUT_MS);
    if (!drained) {
      console.error(`[api] shutdown drain timed out with ${pendingTaskCount()} task(s) pending`);
    }
    await disposeProxyContext();
    process.exit(0);
  });
});
