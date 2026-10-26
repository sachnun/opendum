import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createAuth, type AuthInstance, type AuthSession } from "./auth.js";

export class IdentityService {
  readonly auth: AuthInstance;

  constructor(auth: AuthInstance = createAuth()) {
    this.auth = auth;
  }

  verifyAccessToken(token: string): Effect.Effect<unknown | null> {
    return Effect.tryPromise({
      try: () => this.auth.api.verifyJWT({ body: { token } }),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((result) => result.payload ?? null),
      Effect.catch(() => Effect.succeed(null))
    );
  }

  sessionFromHeaders(headers: Headers): Effect.Effect<AuthSession | null> {
    return Effect.tryPromise({
      try: () => this.auth.api.getSession({ headers }),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
  }

  tokenFromHeaders(headers: Headers): Effect.Effect<string | null> {
    return Effect.tryPromise({
      try: () => this.auth.api.getToken({ headers }),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((result) => result?.token ?? null),
      Effect.catch(() => Effect.succeed(null))
    );
  }
}

export class IdentityTag extends Context.Service<IdentityTag, IdentityService>()("opendum/identity") {}

export const IdentityLayer = Layer.effect(
  IdentityTag,
  Effect.sync(() => new IdentityService())
);

type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<typeof IdentityLayer>, Layer.Error<typeof IdentityLayer>>;

let runtime: Runtime | undefined;

export function getIdentity(): Effect.Effect<IdentityService> {
  return Effect.gen(function* () {
    const active = yield* Effect.sync(() => {
      runtime ??= ManagedRuntime.make(IdentityLayer);
      return runtime;
    });
    return yield* Effect.promise(() =>
      active.runPromise(
        Effect.gen(function* () {
          return yield* IdentityTag;
        })
      )
    );
  });
}
