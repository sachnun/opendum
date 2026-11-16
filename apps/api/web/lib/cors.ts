import { webOrigin } from "@opendum/api/web/lib/oauth";

const DEV_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedWebOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "origin",
  };
}

export function corsPreflight(request: Request): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request),
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400",
    },
  });
}

function isAllowedWebOrigin(origin: string): boolean {
  return DEV_ORIGINS.includes(origin) || webOrigin() === origin;
}
