import { Schema } from "effect";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));
const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));

export class AuthenticationFailure extends Schema.TaggedError<AuthenticationFailure>()(
  "AuthenticationFailure",
  {
    message: Schema.String,
    accountId: Schema.optional(Schema.String),
  }
) {}

export class ValidationFailure extends Schema.TaggedError<ValidationFailure>()("ValidationFailure", {
  message: Schema.String,
  param: OptionalString,
  code: OptionalString,
  status: Schema.optional(Schema.Number),
}) {}

export class RateLimitFailure extends Schema.TaggedError<RateLimitFailure>()("RateLimitFailure", {
  message: Schema.String,
  status: Schema.Number,
  retryAfter: OptionalString,
  afterMs: OptionalNumber,
  accountId: Schema.optional(Schema.String),
}) {}

export class NoAccountsFailure extends Schema.TaggedError<NoAccountsFailure>()("NoAccountsFailure", {
  message: Schema.String,
  status: Schema.Number,
  type: Schema.optional(Schema.String),
}) {}

export class InsufficientPointsFailure extends Schema.TaggedError<InsufficientPointsFailure>()(
  "InsufficientPointsFailure",
  {
    message: Schema.String,
    code: OptionalString,
  }
) {}

export class UpstreamFailure extends Schema.TaggedError<UpstreamFailure>()("UpstreamFailure", {
  message: Schema.String,
  status: Schema.Number,
  type: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
}) {}

export class ConfigurationFailure extends Schema.TaggedError<ConfigurationFailure>()(
  "ConfigurationFailure",
  {
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  }
) {}

export class InternalFailure extends Schema.TaggedError<InternalFailure>()("InternalFailure", {
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  accountId: Schema.optional(Schema.String),
}) {}

export type ProxyFailure =
  | AuthenticationFailure
  | ValidationFailure
  | RateLimitFailure
  | NoAccountsFailure
  | InsufficientPointsFailure
  | UpstreamFailure
  | ConfigurationFailure
  | InternalFailure;

