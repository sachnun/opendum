import { Effect, Result } from "effect";
import type { ProviderAccount, RefreshedCredentials } from "@opendum/providers/types";
import { ProviderCredentialFailure, asError } from "@opendum/providers/core/errors";
import type { UpstreamTransport } from "@opendum/providers/core/http";

export type Spec = {
  provider: string;
  tokenUrl: string | ((refreshToken: string) => string | Promise<string>);
  request: (refreshToken: string) => RequestInit | Promise<RequestInit>;
  parse: (
    payload: unknown,
    refreshToken: string
  ) => Result.Result<RefreshedCredentials, string> | Promise<Result.Result<RefreshedCredentials, string>>;
  transport: UpstreamTransport;
};

function resolve<A>(value: A | Promise<A>): Effect.Effect<A> {
  return Effect.suspend(() => (typeof (value as Promise<A>)?.then === "function" ? Effect.promise(() => value as Promise<A>) : Effect.succeed(value as A)));
}

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
    return Effect.gen(function* () {
      const tokenUrl = spec.tokenUrl;
      const resolvedUrl = typeof tokenUrl === "string" ? tokenUrl : yield* resolve(tokenUrl(refreshToken));
      const url = yield* resolve(resolvedUrl);
      const init = yield* resolve(spec.request(refreshToken));
      const resp = yield* Effect.tryPromise({
        try: () => spec.transport.direct(url, init),
        catch: (cause) =>
          new ProviderCredentialFailure({ message: asError(cause).message, provider: spec.provider, cause }),
      });
      const text = yield* Effect.tryPromise({
        try: () => resp.text(),
        catch: (cause) =>
          new ProviderCredentialFailure({ message: asError(cause).message, provider: spec.provider, cause }),
      });
      if (resp.status < 200 || resp.status >= 300) {
        return yield* Effect.fail(
          new ProviderCredentialFailure({
            message: `${spec.provider} token refresh failed: ${resp.status} ${text.slice(0, 1024)}`,
            provider: spec.provider,
          })
        );
      }
      const payload = yield* Effect.try({
        try: () => JSON.parse(text),
        catch: (cause) =>
          new ProviderCredentialFailure({ message: asError(cause).message, provider: spec.provider, cause }),
      });
      const parsed = yield* resolve(spec.parse(payload, refreshToken));
      if (Result.isFailure(parsed)) {
        return yield* Effect.fail(
          new ProviderCredentialFailure({ message: parsed.failure, provider: spec.provider })
        );
      }
      return parsed.success;
    });
  }
}
