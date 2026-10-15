import { Context, Effect, Layer } from "effect";
import type { AuthService } from "./service.js";
import type { AuthResult, ModelAccess, ModelValidationResult } from "./types.js";

export class AuthServiceTag extends Context.Service<AuthServiceTag, { readonly auth: AuthService }>()(
  "opendum/auth/AuthService"
) {}

export const AuthServiceLayer = (auth: AuthService): Layer.Layer<AuthServiceTag> =>
  Layer.succeed(AuthServiceTag, { auth });

export const validateAPIKey = (
  authHeader: string
): Effect.Effect<AuthResult, never, AuthServiceTag> =>
  Effect.gen(function* () {
    const { auth } = yield* AuthServiceTag;
    return yield* auth.validateAPIKey(authHeader);
  });

export const validateModelForUser = (
  userId: string,
  modelParam: string,
  access: ModelAccess
): Effect.Effect<ModelValidationResult, never, AuthServiceTag> =>
  Effect.gen(function* () {
    const { auth } = yield* AuthServiceTag;
    return yield* auth.validateModelForUser(userId, modelParam, access);
  });
