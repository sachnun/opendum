import { Effect } from "effect";
import {
  ProviderFallbackFailure,
  ProviderRequestFailure,
  ProviderTransportFailure,
  asError,
  failureMessage,
} from "./errors.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type EgressFetch = FetchLike;

export type PostOptions = {
  provider: string;
  fetchFn: FetchLike;
  url: string;
  bearer: string;
  payload: unknown;
  stream: boolean;
  headers?: Record<string, string>;
  onStart?: () => void;
};

export class RequestFailure {
  static normalize<A>(
    provider: string,
    effect: Effect.Effect<A, unknown>
  ): Effect.Effect<A, ProviderRequestFailure> {
    return Effect.catch(effect, (cause) =>
      Effect.fail(
        new ProviderRequestFailure({
          message: asError(cause).message,
          provider,
          cause,
        })
      )
    );
  }

  static transport(provider: string, cause: unknown, url?: string): ProviderTransportFailure {
    return new ProviderTransportFailure({
      message: failureMessage(cause),
      provider,
      url,
      cause,
    });
  }

  static fallback(provider: string, cause: unknown): ProviderFallbackFailure {
    return new ProviderFallbackFailure({
      message: failureMessage(cause),
      provider,
      cause,
    });
  }

  static status(resp: Response | null | undefined): number {
    return resp ? resp.status : 0;
  }
}

export class JSONPoster {
  private readonly auth: boolean;

  constructor(auth: boolean) {
    this.auth = auth;
  }

  send(options: PostOptions): Effect.Effect<Response, ProviderTransportFailure> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.auth) headers.Authorization = `Bearer ${options.bearer.trim()}`;
    headers.Accept = options.stream ? "text/event-stream" : "application/json";
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) headers[key] = value;
    }

    return Effect.tryPromise({
      try: async () => {
        const resp = await options.fetchFn(options.url, {
          method: "POST",
          headers,
          body: JSON.stringify(options.payload),
        });
        options.onStart?.();
        return resp;
      },
      catch: (cause) => RequestFailure.transport(options.provider, cause, options.url),
    });
  }

  static withAuth(options: PostOptions): Effect.Effect<Response, ProviderTransportFailure> {
    return new JSONPoster(true).send(options);
  }

  static anonymous(options: PostOptions): Effect.Effect<Response, ProviderTransportFailure> {
    return new JSONPoster(false).send(options);
  }
}
