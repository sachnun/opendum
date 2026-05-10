type InternalRelayInit = Omit<RequestInit, "headers" | "body"> & {
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown> | null;
};

export class InternalRelayNotConfiguredError extends Error {
  constructor() {
    super("NUXT_PUBLIC_PROXY_URL is required for external provider validation.");
    this.name = "InternalRelayNotConfiguredError";
  }
}

function getProxyBaseUrl() {
  const value = process.env.NUXT_PUBLIC_PROXY_URL?.trim().replace(/\/+$/, "");
  return value || null;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

function normalizeBody(body: InternalRelayInit["body"]): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return body;
}

export async function fetchInternalProvider(url: string, init: InternalRelayInit = {}): Promise<Response> {
  const proxyBaseUrl = getProxyBaseUrl();
  if (!proxyBaseUrl) throw new InternalRelayNotConfiguredError();

  const payload = {
    url,
    method: init.method,
    headers: normalizeHeaders(init.headers),
    body: normalizeBody(init.body),
  };

  return fetch(`${proxyBaseUrl}/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    signal: init.signal,
    cache: "no-store",
  });
}
