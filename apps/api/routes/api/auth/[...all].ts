import { defineHandler } from "nitro";
import { Effect } from "effect";

import { corsHeaders, corsPreflight } from "@opendum/api/web/lib/cors";
import { identityService } from "@opendum/api/web/utils/session";

export default defineHandler(async (event) => {
  const request = event.req;
  if (request.method === "OPTIONS") return corsPreflight(request);
  const response = await Effect.runPromise(identityService()).then((identity) =>
    identity.auth.handler(request)
  );
  const headers = corsHeaders(request);
  if (!headers["access-control-allow-origin"]) return response;

  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
});
