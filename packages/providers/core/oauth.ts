import { Effect } from "effect";
import type { ProviderAccount, RefreshedCredentials } from "@opendum/providers/types";
import { ProviderCredentialFailure, asError } from "@opendum/providers/core/errors";
import type { UpstreamTransport } from "@opendum/providers/core/http";

export type Spec = {
  provider: string;
  tokenUrl: string | ((refreshToken: string) => string | Promise<string>);
  request: (refreshToken: string) => RequestInit | Promise<RequestInit>;
  parse: (payload: unknown, refreshToken: string) => RefreshedCredentials | Promise<RefreshedCredentials>;
  transport: UpstreamTransport;
};

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

export abstract class OAuthBase {
  protected readonly exchange: OAuth;

  constructor(spec: Spec) {
    this.exchange = new OAuth(spec);
  }

  abstract refreshBuffer(): number;

  refreshCredentials(
    refreshToken: string,
    account: ProviderAccount
  ): Effect.Effect<RefreshedCredentials, ProviderCredentialFailure> {
    return this.exchange.exchange(refreshToken, account);
  }
}
