import { Effect } from "effect";
import { hostError } from "@opendum/core/egress/ssrf";
import { guardedFetch, type Fetch, type FetchHandle, type GuardedFetchOptions } from "@opendum/core/egress/guard";

export const MAX_REDIRECTS = 10;

export class RedirectFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedirectFailure";
  }
}

function cancelBody(response: Response): Effect.Effect<void, RedirectFailure> {
  return Effect.ignore(
    Effect.tryPromise({
      try: async () => {
        await response.body?.cancel();
      },
      catch: (cause) => new RedirectFailure(String(cause)),
    })
  );
}

function requestHop(baseFetch: Fetch, url: string, init: RequestInit | undefined): Effect.Effect<Response, RedirectFailure> {
  return Effect.tryPromise({
    try: () => baseFetch(url, { ...init, redirect: "manual" }),
    catch: (cause) => new RedirectFailure(String(cause)),
  });
}

function rewrittenInit(response: Response, init: RequestInit | undefined): RequestInit | undefined {
  const method = (init?.method ?? "GET").toUpperCase();
  const downgrade =
    response.status === 303 ||
    ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD");
  return downgrade ? { ...init, method: "GET", body: undefined } : init;
}

export class Redirects {
  readonly maxRedirects: number;

  constructor(maxRedirects: number = MAX_REDIRECTS) {
    this.maxRedirects = maxRedirects;
  }

  follow(baseFetch: Fetch, url: string, init?: RequestInit): Effect.Effect<Response, RedirectFailure> {
    const limit = this.maxRedirects;
    return Effect.gen(function* () {
      let current = url;
      let currentInit = init;
      for (let hop = 0; hop <= limit; hop += 1) {
        const host = new URL(current).hostname;
        const hostFailure = hostError(host);
        if (hostFailure) return yield* Effect.fail(new RedirectFailure(hostFailure.message));
        const response = yield* requestHop(baseFetch, current, currentInit);
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        if (!location) return response;
        yield* cancelBody(response);
        if (hop === limit) {
          return yield* Effect.fail(new RedirectFailure("stopped after 10 redirects"));
        }
        const next = new URL(location, current);
        if (next.protocol !== "https:") {
          return yield* Effect.fail(new RedirectFailure("redirect must use https"));
        }
        currentInit = rewrittenInit(response, currentInit);
        current = next.toString();
      }
      return yield* Effect.fail(new RedirectFailure("stopped after 10 redirects"));
    });
  }
}

export class Fetcher {
  readonly policy: Redirects;
  private readonly handle: FetchHandle;

  constructor(options: GuardedFetchOptions & { policy?: Redirects } = {}) {
    this.policy = options.policy ?? new Redirects();
    this.handle = guardedFetch(options);
  }

  fetch(url: string, init?: RequestInit): Effect.Effect<Response, RedirectFailure> {
    return this.policy.follow(this.handle.fetch, url, init);
  }

  close(): Effect.Effect<void, RedirectFailure> {
    return Effect.tryPromise({
      try: () => this.handle.close(),
      catch: (cause) => new RedirectFailure(String(cause)),
    });
  }
}
