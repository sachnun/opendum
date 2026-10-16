import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { createAuth, type AuthInstance, type AuthSession } from "./auth.js";

export class IdentityService {
  readonly auth: AuthInstance;

  constructor(auth: AuthInstance = createAuth()) {
    this.auth = auth;
  }

  verifyAccessToken(token: string): Effect.Effect<unknown | null> {
    return Effect.promise(async () => {
      try {
        const { payload } = await this.auth.api.verifyJWT({ body: { token } });
        return payload ?? null;
      } catch {
        return null;
      }
    });
  }

  sessionFromHeaders(headers: Headers): Effect.Effect<AuthSession | null> {
    return Effect.promise(async () => {
      try {
        return await this.auth.api.getSession({ headers });
      } catch {
        return null;
      }
    });
  }

  accessTokenFromHeaders(headers: Headers): Effect.Effect<string | null> {
    return Effect.promise(async () => {
      try {
        const result = await this.auth.api.getToken({ headers });
        return result?.token ?? null;
      } catch {
        return null;
      }
    });
  }
}

export class IdentityTag extends Context.Service<IdentityTag, IdentityService>()("opendum/identity") {}

export const IdentityLayer = Layer.effect(
  IdentityTag,
  Effect.sync(() => new IdentityService())
);

type Runtime = ManagedRuntime.ManagedRuntime<Layer.Success<typeof IdentityLayer>, Layer.Error<typeof IdentityLayer>>;

let runtime: Runtime | undefined;

export function getIdentity(): Promise<IdentityService> {
  runtime ??= ManagedRuntime.make(IdentityLayer);
  return runtime.runPromise(
    Effect.gen(function* () {
      return yield* IdentityTag;
    })
  );
}
