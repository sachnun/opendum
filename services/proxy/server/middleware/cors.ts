import { defineMiddleware } from "nitro";
import { corsPreflight } from "../../src/middleware/cors.js";

export default defineMiddleware((event, next) => {
  if (event.req.method === "OPTIONS") return corsPreflight();
  return next();
});
