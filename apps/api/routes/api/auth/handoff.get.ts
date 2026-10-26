import { defineHandler } from "nitro";
import { getQuery, HTTPError } from "h3";
import { Effect } from "effect";
import { raise } from "@opendum/core/raise";

import { webOrigin, safePath, loginUrl } from "@opendum/api/web/lib/handoff";
import { sessionOf, mintAccessToken } from "@opendum/api/web/utils/session";

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

export default defineHandler(async (event) => {
  const query = getQuery(event);
  const origin = webOrigin(query.to);
  if (!origin) raise(new HTTPError({ status: 400, statusText: "Invalid web origin" }));

  const redirect = safePath(query.redirect);
  const error = typeof query.error === "string" ? query.error.trim() : "";

  if (error) return redirectTo(loginUrl(origin, { error, redirect }));

  const session = await Effect.runPromise(
    sessionOf(event).pipe(Effect.catch(() => Effect.succeed(null)))
  );
  const sessionToken = session?.session?.token;
  if (!session?.user?.id || !sessionToken) return redirectTo(loginUrl(origin, { error: "SessionExpired", redirect }));

  const token = await Effect.runPromise(mintAccessToken(event));
  if (!token) return redirectTo(loginUrl(origin, { error: "SessionExpired", redirect }));

  return redirectTo(loginUrl(origin, { token, session: sessionToken, redirect }));
});
