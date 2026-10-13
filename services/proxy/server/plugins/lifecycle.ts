import { definePlugin } from "nitro";
import { applyCors } from "../../src/middleware/cors.js";
import { disposeProxyContext } from "../context.js";

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("response", (response) => {
    applyCors(response.headers);
  });

  nitroApp.hooks.hook("close", async () => {
    await disposeProxyContext();
    process.exit(0);
  });
});
