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

export class ModelTimeoutFailure extends Schema.TaggedError<ModelTimeoutFailure>()(
  "ModelTimeoutFailure",
  {
    message: Schema.String,
    label: Schema.String,
    timeoutMs: Schema.Number,
  }
) {}

export class ModelDecodeFailure extends Schema.TaggedError<ModelDecodeFailure>()(
  "ModelDecodeFailure",
  {
    message: Schema.String,
    label: Schema.String,
    cause: OptionalUnknown,
  }
) {}

export type ModelFailure =
  | ModelsDirectoryFailure
  | ModelReadFailure
  | ModelParseFailure
  | ModelWriteFailure
  | ModelFetchFailure
  | ModelTimeoutFailure
  | ModelDecodeFailure;

export function failureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(failureMessage(cause));
}

export function isRetryable(status: number | undefined): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
