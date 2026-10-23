import { defineHandler } from "nitro";
import { getQuery, HTTPError } from "h3";
import { Effect } from "effect";

import { resolveWebOrigin, sanitizeRedirectPath, signInRedirectUrl } from "#web/lib/handoff.js";
import { getSessionFromEvent, mintAccessToken } from "#web/utils/session.js";

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

export default defineHandler(async (event) => {
  const query = getQuery(event);
  const webOrigin = resolveWebOrigin(query.to);
  if (!webOrigin) throw new HTTPError({ status: 400, statusText: "Invalid web origin" });

  const redirect = sanitizeRedirectPath(query.redirect);
  const error = typeof query.error === "string" ? query.error.trim() : "";

  if (error) return redirectTo(signInRedirectUrl(webOrigin, { error, redirect }));

  const session = await Effect.runPromise(
    getSessionFromEvent(event).pipe(Effect.catch(() => Effect.succeed(null)))
  );
  const sessionToken = session?.session?.token;
  if (!session?.user?.id || !sessionToken) return redirectTo(signInRedirectUrl(webOrigin, { error: "SessionExpired", redirect }));

  const token = await Effect.runPromise(mintAccessToken(event));
  if (!token) return redirectTo(signInRedirectUrl(webOrigin, { error: "SessionExpired", redirect }));

  return redirectTo(signInRedirectUrl(webOrigin, { token, session: sessionToken, redirect }));
});
