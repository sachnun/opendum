import type { H3Event } from "h3";

function forwardedValue(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
}

export function requestOrigin(event: H3Event): string {
  const url = event.url ?? new URL(event.req.url);
  const proto = forwardedValue(event.req.headers.get("x-forwarded-proto")) ?? url.protocol.replace(":", "");
  const host = forwardedValue(event.req.headers.get("x-forwarded-host")) ?? event.req.headers.get("host") ?? url.host;
  return host ? `${proto}://${host}` : url.origin;
}
