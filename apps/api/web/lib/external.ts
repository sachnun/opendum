import { assertPublicHost, PrivateHostError } from "@opendum/core/egress";
import { getProxyContext } from "../../context.js";

const TIMEOUT_MS = 20 * 1000;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type ExternalFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown> | null;
  cache?: RequestCache;
  signal?: AbortSignal;
};

function resolveTarget(url: string, method: string): { method: string; target: string } {
  if (!ALLOWED_METHODS.has(method)) throw new Error(`unsupported external fetch method: ${method}`);
  if (!URL.canParse(url)) throw new Error("url is invalid");

  const target = new URL(url);
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password) {
    throw new Error("url must be an https provider URL");
  }

  try {
    assertPublicHost(target.hostname);
  } catch (error) {
    if (error instanceof PrivateHostError) throw new Error("url must not target a private network address");
    throw error;
  }

  return { method, target: target.toString() };
}

function normalizeBody(body: ExternalFetchInit["body"]): BodyInit | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body as BodyInit;
  return JSON.stringify(body);
}

export async function fetchExternal(url: string, init: ExternalFetchInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const resolved = resolveTarget(url, method);
  const context = await getProxyContext();
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);

  return context.guardedFetch(resolved.target, {
    method: resolved.method,
    headers: init.headers,
    body: normalizeBody(init.body),
    cache: init.cache,
    signal,
  });
}
