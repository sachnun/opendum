import { Effect } from "effect";

import type { AuthFailure } from "@opendum/providers/auth/failure";
import { ProviderResponse } from "@opendum/providers/auth/response";
import type { AuthRuntime, ExternalInit } from "@opendum/providers/auth/runtime";

export type OAuthSpec = {
  readonly provider: string;
  readonly label: string;
};

export type TokenRequest = {
  readonly url: string;
  readonly init: ExternalInit;
  readonly endpoint: string;
};

export abstract class OAuthClient {
  protected readonly runtime: AuthRuntime;
  protected readonly response: ProviderResponse;
  protected readonly spec: OAuthSpec;

  constructor(spec: OAuthSpec, runtime: AuthRuntime) {
    this.spec = spec;
    this.runtime = runtime;
    this.response = new ProviderResponse(spec.label);
  }

  protected get provider(): string {
    return this.spec.provider;
  }

  call(url: string, init: ExternalInit): Effect.Effect<Response, AuthFailure> {
    return this.runtime.fetch(url, init);
  }

  fail(message: string, cause?: unknown): AuthFailure {
    return this.runtime.unavailable(message, cause);
  }

  reject(message: string): AuthFailure {
    return this.runtime.badRequest(message);
  }

  decode<T>(request: TokenRequest, pick: (payload: unknown) => T | null): Effect.Effect<T, AuthFailure> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* this.call(request.url, request.init);
      if (!result.ok) {
        const body = yield* this.response.text(result);
        return yield* this.fail(this.response.failure(result, body, request.endpoint));
      }
      const payload = yield* this.response.jsonOr<unknown>(result, null);
      const value = pick(payload);
      if (value === null) {
        return yield* this.fail(`${this.spec.label} ${request.endpoint} returned an unexpected payload`);
      }
      return value;
    });
  }

  protected requireText(value: string, message: string): Effect.Effect<string, AuthFailure> {
    return value.trim() ? Effect.succeed(value.trim()) : Effect.fail(this.fail(message));
  }

}

export function tokenLifetime(seconds: number | undefined, fallback = 3600): Date {
  const value = seconds && seconds > 0 ? seconds : fallback;
  return new Date(Date.now() + value * 1000);
}
