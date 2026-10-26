import { definePlugin } from "nitro";
import { disposeContext } from "../context.js";
import { pendingCount, settleTasks } from "../core/pending.js";

const DRAIN_TIMEOUT_MS = 4_000;

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    const drained = await settleTasks(DRAIN_TIMEOUT_MS);
    if (!drained) {
      console.error(`[api] shutdown drain timed out with ${pendingCount()} task(s) pending`);
    }
    await disposeContext();
    process.exit(0);
  });
});
