import { defineHandler } from "nitro";

export default defineHandler(
  () => new Response(null, { status: 308, headers: { location: "/v1" } })
);
