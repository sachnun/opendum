import { defineHandler } from "nitro";
import { Effect } from "effect";

import { identityService } from "#web/utils/session.js";

export default defineHandler(async (event) => {
  const identity = await Effect.runPromise(identityService());
  return identity.auth.handler(event.req);
});
