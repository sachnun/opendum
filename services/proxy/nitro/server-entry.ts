import { defineHandler } from "nitro";
import { proxyApp } from "./context.js";

export default defineHandler(async (event) => {
  const app = await proxyApp();
  return app.handler(event);
});
