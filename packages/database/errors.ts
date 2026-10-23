import { Effect, Schema } from "effect";

const OptionalUnknown = Schema.optional(Schema.Unknown);

export class DatabaseFailure extends Schema.TaggedError<DatabaseFailure>()("DatabaseFailure", {
  message: Schema.String,
  operation: Schema.String,
  cause: OptionalUnknown,
}) {}

export function databaseFailure(operation: string, cause: unknown): DatabaseFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new DatabaseFailure({ message, operation, cause });
}

export function tryDb<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, DatabaseFailure> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => databaseFailure(operation, cause),
  });
}
