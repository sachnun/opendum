import { defineHandler } from "nitro";
import { notFound, unknownEndpoint } from "@opendum/api/handlers/errors";
import { protectedResourceMetadata } from "@opendum/api/mcp/auth";

export default defineHandler((event) => {
  const pathname = event.url.pathname;
  if (pathname === "/.well-known/oauth-protected-resource/mcp") return protectedResourceMetadata(event.req);
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return unknownEndpoint();
  }
  return notFound();
});
