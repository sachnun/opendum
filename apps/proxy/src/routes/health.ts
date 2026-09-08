import { Hono } from "hono";
import { writeOpenAIError } from "../errors.js";

export function createHealthRoute() {
  const router = new Hono();

  router.get("/health", (c) => c.json({ status: "ok" }));

  router.get("/", (c) => c.redirect("/v1", 308));

  router.get("/v1", (c) =>
    writeOpenAIError(c, 404, {
      message: "Unknown API endpoint.",
      type: "invalid_request_error",
    })
  );

  return router;
}
