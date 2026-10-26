import { defineHandler } from "nitro";
import { Effect } from "effect";

import { identityService } from "@opendum/api/web/utils/session";

export default defineHandler(async (event) => {
  const identity = await Effect.runPromise(identityService());
  return identity.auth.handler(event.req);
});
