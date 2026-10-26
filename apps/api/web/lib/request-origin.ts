import type { H3Event } from "h3";

function forwardedValue(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
}

export function originOf(headers: Headers, url: string): string {
  const parsed = new URL(url);
  const proto = forwardedValue(headers.get("x-forwarded-proto")) ?? parsed.protocol.replace(":", "");
  const host = forwardedValue(headers.get("x-forwarded-host")) ?? headers.get("host") ?? parsed.host;
  return host ? `${proto}://${host}` : parsed.origin;
}

export function requestOrigin(event: H3Event): string {
  return originOf(event.req.headers, String(event.url ?? event.req.url));
}
