import { defineHandler } from "nitro";

import { identityService } from "#web/utils/session.js";

export default defineHandler(async (event) => {
  const identity = await identityService();
  return identity.auth.handler(event.req);
});
