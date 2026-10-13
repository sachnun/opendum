import { definePlugin } from "nitro";
import { disposeProxyContext } from "./context.js";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("close", async () => {
    await disposeProxyContext();
    process.exit(0);
  });
});
