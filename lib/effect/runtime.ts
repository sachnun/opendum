import { Effect, Layer } from "effect";
import {
  RedisLive,
  DatabaseLive,
  SessionLive,
} from "./services";
import type {
  UnauthorizedError,
  DatabaseError,
  RedisError,
  ValidationError,
  NotFoundError,
} from "./errors";

// ---------------------------------------------------------------------------
// Composed layers
// ---------------------------------------------------------------------------

/**
 * Layer that provides Redis + Database (no session — for non-authenticated contexts).
 */
export const InfraLayer = Layer.merge(RedisLive, DatabaseLive);

/**
 * Full layer providing Redis + Database + Session.
 * Used for server actions that require authentication.
 */
export const MainLayer = Layer.merge(InfraLayer, SessionLive);

// ---------------------------------------------------------------------------
// ActionResult compatibility
// ---------------------------------------------------------------------------

export type ActionResult<T = void> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Map a known tagged error into the existing ActionResult shape.
 */
function errorToMessage(
  error: UnauthorizedError | DatabaseError | RedisError | ValidationError | NotFoundError
): string {
  switch (error._tag) {
    case "UnauthorizedError":
      return error.message;
    case "NotFoundError":
      return error.message;
    case "ValidationError":
      return error.message;
    case "RedisError":
      return "A temporary error occurred. Please try again.";
    case "DatabaseError":
      return "A temporary error occurred. Please try again.";
  }
}

/**
 * Run an Effect program that may fail with known error types and convert the
 * result into the existing `ActionResult<A>` shape used by server actions.
 *
 * The provided `layer` should satisfy all service requirements of the effect.
 *
 * Usage:
 * ```ts
 * export async function myAction(): Promise<ActionResult<Foo>> {
 *   return runServerAction(
 *     Effect.gen(function* () {
 *       const userId = yield* requireUserId;
 *       // ... business logic
 *       return foo;
 *     }),
 *     MainLayer,
 *   );
 * }
 * ```
 */
export async function runServerAction<A>(
  effect: Effect.Effect<
    A,
    UnauthorizedError | DatabaseError | RedisError | ValidationError | NotFoundError,
    never
  >
): Promise<ActionResult<A>>;
export async function runServerAction<A, R>(
  effect: Effect.Effect<
    A,
    UnauthorizedError | DatabaseError | RedisError | ValidationError | NotFoundError,
    R
  >,
  layer: Layer.Layer<R, UnauthorizedError | DatabaseError | RedisError, never>
): Promise<ActionResult<A>>;
export async function runServerAction<A, R>(
  effect: Effect.Effect<
    A,
    UnauthorizedError | DatabaseError | RedisError | ValidationError | NotFoundError,
    R
  >,
  layer?: Layer.Layer<R, UnauthorizedError | DatabaseError | RedisError, never>
): Promise<ActionResult<A>> {
  const provided = layer
    ? Effect.provide(effect, layer)
    : (effect as Effect.Effect<A, UnauthorizedError | DatabaseError | RedisError | ValidationError | NotFoundError, never>);

  const result = await Effect.runPromise(
    provided.pipe(
      Effect.map((data): ActionResult<A> => ({ success: true, data })),
      Effect.catchAll((error) =>
        Effect.succeed<ActionResult<A>>({
          success: false,
          error: errorToMessage(error),
        })
      )
    )
  );

  return result;
}

/**
 * Run an Effect that uses only infra services (Redis + Database).
 * Convenience wrapper for non-action contexts (e.g. proxy layer).
 */
export async function runInfra<A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> {
  return Effect.runPromise(effect);
}

/**
 * Run an Effect that needs Redis + Database services.
 */
export async function runWithInfra<A, E>(
  effect: Effect.Effect<
    A,
    E,
    import("./services").RedisService | import("./services").DatabaseService
  >
): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, InfraLayer));
}
