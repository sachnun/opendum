import { Schema } from "effect";

const OptionalUnknown = Schema.optional(Schema.Unknown);

export class ModelsDirectoryFailure extends Schema.TaggedError<ModelsDirectoryFailure>()(
  "ModelsDirectoryFailure",
  {
    message: Schema.String,
    path: Schema.String,
    cause: OptionalUnknown,
  }
) {}

export class ModelReadFailure extends Schema.TaggedError<ModelReadFailure>()("ModelReadFailure", {
  message: Schema.String,
  path: Schema.String,
  cause: OptionalUnknown,
}) {}

export class ModelParseFailure extends Schema.TaggedError<ModelParseFailure>()("ModelParseFailure", {
  message: Schema.String,
  path: Schema.String,
  cause: OptionalUnknown,
}) {}

export class ModelWriteFailure extends Schema.TaggedError<ModelWriteFailure>()("ModelWriteFailure", {
  message: Schema.String,
  path: Schema.String,
  cause: OptionalUnknown,
}) {}

export class ModelFetchFailure extends Schema.TaggedError<ModelFetchFailure>()("ModelFetchFailure", {
  message: Schema.String,
  label: Schema.String,
  status: Schema.optional(Schema.Number),
  attempts: Schema.optional(Schema.Number),
  cause: OptionalUnknown,
}) {}

export type ModelFailure =
  | ModelsDirectoryFailure
  | ModelReadFailure
  | ModelParseFailure
  | ModelWriteFailure
  | ModelFetchFailure;

export function modelFailureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(modelFailureMessage(cause));
}
