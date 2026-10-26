import { RPCHandler } from "@orpc/server/fetch";
import { defineHandler } from "nitro";

import { router } from "@opendum/api/web/orpc/router";
import { notFound } from "@opendum/api/handlers/errors";

const handler = new RPCHandler(router);

export default defineHandler(async (event) => {
  const { matched, response } = await handler.handle(event.req, {
    prefix: "/rpc",
    context: { headers: event.req.headers, url: event.req.url },
  });

  if (!matched) return notFound();
  return response;
});
