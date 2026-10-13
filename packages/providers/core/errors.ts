import { Schema } from "effect";

const OptionalString = Schema.optional(Schema.String);
const OptionalNumber = Schema.optional(Schema.Number);
const OptionalUnknown = Schema.optional(Schema.Unknown);

export class ProviderRequestFailure extends Schema.TaggedError<ProviderRequestFailure>()(
  "ProviderRequestFailure",
  {
    message: Schema.String,
    provider: Schema.String,
    status: OptionalNumber,
    cause: OptionalUnknown,
  }
) {}

export class ProviderTransportFailure extends Schema.TaggedError<ProviderTransportFailure>()(
  "ProviderTransportFailure",
  {
    message: Schema.String,
    provider: Schema.String,
    url: OptionalString,
    cause: OptionalUnknown,
  }
) {}

export class ProviderCredentialFailure extends Schema.TaggedError<ProviderCredentialFailure>()(
  "ProviderCredentialFailure",
  {
    message: Schema.String,
    provider: Schema.String,
    status: OptionalNumber,
    cause: OptionalUnknown,
  }
) {}

export class ProviderFallbackFailure extends Schema.TaggedError<ProviderFallbackFailure>()(
  "ProviderFallbackFailure",
  {
    message: Schema.String,
    provider: Schema.String,
    cause: OptionalUnknown,
  }
) {}

export class QuotaFetchFailure extends Schema.TaggedError<QuotaFetchFailure>()("QuotaFetchFailure", {
  message: Schema.String,
  provider: Schema.String,
  status: OptionalNumber,
  expired: Schema.optional(Schema.Boolean),
  url: OptionalString,
  target: OptionalString,
  cause: OptionalUnknown,
}) {}

export class QuotaJournalFailure extends Schema.TaggedError<QuotaJournalFailure>()(
  "QuotaJournalFailure",
  {
    message: Schema.String,
    cause: OptionalUnknown,
  }
) {}

export type ProviderFailure =
  | ProviderRequestFailure
  | ProviderTransportFailure
  | ProviderCredentialFailure
  | ProviderFallbackFailure;

export type QuotaFailure = QuotaFetchFailure | QuotaJournalFailure;

export function providerFailureMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return String(cause);
}

export function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(providerFailureMessage(cause));
}
