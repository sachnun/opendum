import { defineHandler } from "nitro";
import { getQuery, HTTPError } from "h3";
import { z } from "zod";

import { createAuth } from "#web/auth.js";
import { handoffUrl, webOrigin, safePath } from "#web/lib/handoff.js";
import { requestOrigin } from "#web/lib/request-origin.js";

const providerSchema = z.enum(["github", "google"]);

export default defineHandler(async (event) => {
  const query = getQuery(event);
  const target = webOrigin(query.to);
  if (!target) throw new HTTPError({ status: 400, statusText: "Invalid web origin" });

  const provider = providerSchema.safeParse(typeof query.provider === "string" ? query.provider.trim() : undefined);
  if (!provider.success) throw new HTTPError({ status: 400, statusText: "Unsupported sign in provider" });

  const baseUrl = process.env.BETTER_AUTH_URL?.trim().replace(/\/+$/, "") || requestOrigin(event);
  const callbackURL = handoffUrl(baseUrl, { to: target, redirect: safePath(query.redirect) });

  const { headers, response } = await createAuth(undefined, { baseURL: baseUrl }).api.signInSocial({
    body: { provider: provider.data, callbackURL },
    returnHeaders: true,
  });

  if (!response?.url) throw new HTTPError({ status: 502, statusText: "Failed to start sign in" });

  const redirect = new Response(null, { status: 302, headers: { location: response.url } });
  for (const cookie of headers.getSetCookie()) {
    redirect.headers.append("set-cookie", cookie);
  }

  return redirect;
});
