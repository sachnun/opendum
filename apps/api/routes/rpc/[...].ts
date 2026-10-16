import { RPCHandler } from "@orpc/server/fetch";
import { defineHandler } from "nitro";

import { router } from "#web/orpc/router.js";
import { notFound } from "../../handlers/errors.js";

const handler = new RPCHandler(router);

export default defineHandler(async (event) => {
  const { matched, response } = await handler.handle(event.req, {
    prefix: "/rpc",
    context: { headers: event.req.headers, url: event.req.url },
  });

  if (!matched) return notFound();
  return response;
});
