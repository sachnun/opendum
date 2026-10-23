import { Effect } from "effect";
import { assertPublicHost, PrivateHostError } from "@opendum/core/egress";
import { getProxyContext } from "../../context.js";
import { ServiceFailure, asServiceFailure, badRequest, unavailable } from "../errors.js";

const TIMEOUT_MS = 20 * 1000;

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export type ExternalFetchInit = {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | Record<string, unknown> | null;
  cache?: RequestCache;
  signal?: AbortSignal;
};

type Target = { method: string; target: string };

function resolveTarget(url: string, method: string): Effect.Effect<Target, ServiceFailure> {
  if (!ALLOWED_METHODS.has(method)) {
    return Effect.fail(badRequest(`unsupported external fetch method: ${method}`));
  }
  if (!URL.canParse(url)) return Effect.fail(badRequest("url is invalid"));

  const target = new URL(url);
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password) {
    return Effect.fail(badRequest("url must be an https provider URL"));
  }

  return Effect.try({
    try: () => {
      assertPublicHost(target.hostname);
      return { method, target: target.toString() };
    },
    catch: (cause) =>
      cause instanceof PrivateHostError
        ? badRequest("url must not target a private network address")
        : asServiceFailure(cause),
  });
}

function normalizeBody(body: ExternalFetchInit["body"]): BodyInit | undefined {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body as BodyInit;
  }
  return JSON.stringify(body);
}

function abortSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export const fetchExternalEffect = Effect.fn("fetchExternal")(function* (
  url: string,
  init: ExternalFetchInit = {}
) {
  const method = (init.method ?? "GET").toUpperCase();
  const resolved = yield* resolveTarget(url, method);
  const context = yield* Effect.tryPromise({
    try: () => getProxyContext(),
    catch: (cause) => unavailable("Failed to start the proxy runtime", cause),
  });

  return yield* Effect.tryPromise({
    try: () =>
      context.guardedFetch(resolved.target, {
        method: resolved.method,
        headers: init.headers,
        body: normalizeBody(init.body),
        cache: init.cache,
        signal: abortSignal(init.signal),
      }),
    catch: (cause) => asServiceFailure(cause, "External request failed"),
  });
});

export async function fetchExternal(url: string, init: ExternalFetchInit = {}): Promise<Response> {
  return Effect.runPromise(fetchExternalEffect(url, init));
}
