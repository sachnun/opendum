import { defineHandler } from "nitro";
import { notFound, unknownEndpoint } from "../../src/routes/errors.js";

export default defineHandler((event) => {
  const pathname = event.url.pathname;
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return unknownEndpoint();
  }
  return notFound();
});
