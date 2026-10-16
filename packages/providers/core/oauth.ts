import { Effect } from "effect";
import type { ProviderAccount, RefreshedCredentials } from "../types.js";
import { ProviderCredentialFailure, asError } from "./errors.js";
import type { UpstreamTransport } from "./http.js";

/** Per-provider differences of a token refresh POST. */
export type Spec = {
  /** Provider id attached to credential failures. */
  provider: string;
  /** Token endpoint; a function resolves it lazily when config discovery is async. */
  tokenUrl: string | ((refreshToken: string) => string | Promise<string>);
  /** Headers and body for the refresh POST; may resolve asynchronously. */
  request: (refreshToken: string) => RequestInit | Promise<RequestInit>;
  /**
   * Decodes the payload into credentials. Providers with extra lookups behind
   * the token (tier, account info) may return a promise.
   */
  parse: (payload: unknown, refreshToken: string) => RefreshedCredentials | Promise<RefreshedCredentials>;
  /** Transport used for the refresh call. */
  transport: UpstreamTransport;
};

/**
 * Shared skeleton of a token refresh: POST the endpoint, reject non-2xx
 * responses, decode JSON, and report every failure as ProviderCredentialFailure.
 */
export class OAuth {
  private readonly spec: Spec;

  constructor(spec: Spec) {
    this.spec = spec;
  }

  exchange(
    refreshToken: string,
    _account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    const spec = this.spec;
    return Effect.tryPromise({
      try: async () => {
        const url = typeof spec.tokenUrl === "string" ? spec.tokenUrl : await spec.tokenUrl(refreshToken);
        const resp = await spec.transport.direct(url, await spec.request(refreshToken));
        const text = await resp.text();
        if (resp.status < 200 || resp.status >= 300) {
          throw new Error(`${spec.provider} token refresh failed: ${resp.status} ${text.slice(0, 1024)}`);
        }
        return await spec.parse(JSON.parse(text), refreshToken);
      },
      catch: (cause) =>
        new ProviderCredentialFailure({
          message: asError(cause).message,
          provider: spec.provider,
          cause,
        }),
    });
  }
}
