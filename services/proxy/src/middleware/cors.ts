import { H3, defineHandler } from "h3";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

export function applyCors(headers: Headers): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
}

export function corsPreflight(): Response {
  const headers = new Headers();
  applyCors(headers);
  return new Response(null, { status: 204, headers });
}

export function defineCorsOptions(app: H3): void {
  app.options(
    "/**",
    defineHandler(() => corsPreflight())
  );
}
