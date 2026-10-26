import { Effect } from "effect";
import { tryAsync } from "../best-effort.js";
import { assertPublic } from "./ssrf.js";
import { guardedFetch, type Fetch, type FetchHandle, type GuardedFetchOptions } from "./guard.js";

export const MAX_REDIRECTS = 10;

export class Redirects {
  readonly maxRedirects: number;

  constructor(maxRedirects: number = MAX_REDIRECTS) {
    this.maxRedirects = maxRedirects;
  }

  async follow(baseFetch: Fetch, url: string, init?: RequestInit): Promise<Response> {
    let current = url;
    let currentInit = init;
    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const parsed = new URL(current);
      assertPublic(parsed.hostname);
      const response = await baseFetch(current, { ...currentInit, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await Effect.runPromise(tryAsync(() => response.body?.cancel() ?? Promise.resolve(), undefined));
      if (hop === this.maxRedirects) throw new Error("stopped after 10 redirects");
      const next = new URL(location, current);
      if (next.protocol !== "https:") throw new Error("redirect must use https");
      const method = (currentInit?.method ?? "GET").toUpperCase();
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
        currentInit = { ...currentInit, method: "GET", body: undefined };
      }
      current = next.toString();
    }
    throw new Error("stopped after 10 redirects");
  }
}

export class Fetcher {
  readonly policy: Redirects;
  private readonly handle: FetchHandle;

  constructor(options: GuardedFetchOptions & { policy?: Redirects } = {}) {
    this.policy = options.policy ?? new Redirects();
    this.handle = guardedFetch(options);
  }

  fetch(url: string, init?: RequestInit): Promise<Response> {
    return this.policy.follow(this.handle.fetch, url, init);
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}
