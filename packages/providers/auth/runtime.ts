import { Effect } from "effect";

import type { CredentialStore } from "@opendum/providers/auth/credentials";
import { asFailure, type AuthFailure } from "@opendum/providers/auth/failure";
import type { ExternalInit } from "@opendum/providers/auth/external";

export function fromPromise<A>(run: () => Promise<A>): Effect.Effect<A, AuthFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => asFailure(cause),
  });
}

export type AuthRuntime = {
  readonly fetch: (url: string, init?: ExternalInit) => Effect.Effect<Response, AuthFailure>;
  readonly unavailable: (message: string, cause?: unknown) => AuthFailure;
  readonly badRequest: (message: string) => AuthFailure;
  readonly store: CredentialStore;
  readonly hash: (text: string) => string;
  readonly saveAccountId: (accountId: string, value: string) => Effect.Effect<void, unknown>;
};
