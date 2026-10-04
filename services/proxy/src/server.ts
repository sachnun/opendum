import { H3, defineHandler } from "h3";
import type { ProxyContext } from "./context.js";
import { defineCorsOptions } from "./middleware/cors.js";
import { jsonResponse, notFound, unknownEndpoint } from "./routes/errors.js";
import { registerModelsRoute } from "./routes/models.js";
import { registerInferenceRoutes } from "./routes/inference.js";
import { registerInternalRoutes } from "./routes/internal.js";

export function createServer(context: ProxyContext): H3 {
  const app = new H3();

  defineCorsOptions(app);

  app.get(
    "/health",
    defineHandler(() => jsonResponse({ status: "ok" }))
  );

  app.get(
    "/",
    defineHandler(() => new Response(null, { status: 308, headers: { location: "/v1" } }))
  );

  app.get("/v1", defineHandler(() => unknownEndpoint()));

  registerModelsRoute(app, context);
  registerInferenceRoutes(app, context);
  registerInternalRoutes(app, context);

  app.all(
    "/**",
    defineHandler((event) => {
      const pathname = new URL(event.req.url).pathname;
      if (pathname === "/v1" || pathname.startsWith("/v1/")) {
        return unknownEndpoint();
      }
      return notFound();
    })
  );

  return app;
}
