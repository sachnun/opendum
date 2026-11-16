import { defineHandler } from "nitro";
import { Effect } from "effect";
import { notFound, unknownEndpoint } from "@opendum/api/handlers/errors";
import { getIdentity } from "@opendum/api/web/identity";

export default defineHandler((event) => {
  const pathname = event.url.pathname;
  if (pathname.startsWith("/.well-known/")) {
    return Effect.runPromise(getIdentity()).then((identity) => identity.auth.handler(event.req));
  }
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return unknownEndpoint();
  }
  return notFound();
});
