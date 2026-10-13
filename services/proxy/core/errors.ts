import { Schema } from "effect";
import { stringValue } from "./helpers.js";
import type { ErrorFormat, RouteError } from "./types.js";

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
  retryAfterMs: OptionalNumber,
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

export function toRouteError(error: ProxyFailure): RouteError {
  switch (error._tag) {
    case "AuthenticationFailure":
      return {
        status: 401,
        message: error.message,
        type: "authentication_error",
        accountId: error.accountId,
      };
    case "ValidationFailure":
      return {
        status: error.status ?? 400,
        message: error.message,
        type: "invalid_request_error",
        param: error.param ?? null,
        code: error.code ?? null,
      };
    case "RateLimitFailure":
      return {
        status: error.status,
        message: error.message,
        type: "rate_limit_error",
        retryAfter: error.retryAfter ?? null,
        retryAfterMs: error.retryAfterMs ?? null,
        accountId: error.accountId,
      };
    case "NoAccountsFailure":
      return {
        status: error.status,
        message: error.message,
        type: error.type ?? "api_error",
      };
    case "InsufficientPointsFailure":
      return {
        status: 402,
        message: error.message,
        type: "insufficient_quota",
        code: error.code ?? "insufficient_points",
      };
    case "UpstreamFailure":
      return {
        status: error.status,
        message: error.message,
        type: error.type ?? "api_error",
        accountId: error.accountId,
      };
    case "ConfigurationFailure":
      return {
        status: error.status ?? 503,
        message: error.message,
        type: "configuration_error",
      };
    case "InternalFailure":
      return {
        status: error.status ?? 500,
        message: error.message,
        type: "api_error",
        accountId: error.accountId,
      };
  }
}

export function fromRouteError(error: RouteError): ProxyFailure {
  if (error.status === 401) {
    return new AuthenticationFailure({ message: error.message, accountId: error.accountId });
  }
  if (error.status === 402) {
    return new InsufficientPointsFailure({ message: error.message, code: error.code ?? null });
  }
  if (error.status === 429 || error.status === 529) {
    return new RateLimitFailure({
      message: error.message,
      status: error.status,
      retryAfter: error.retryAfter ?? null,
      retryAfterMs: error.retryAfterMs ?? null,
      accountId: error.accountId,
    });
  }
  if (error.type === "configuration_error") {
    return new ConfigurationFailure({ message: error.message, status: error.status });
  }
  if (error.status === 503) {
    return new NoAccountsFailure({ message: error.message, status: error.status, type: error.type });
  }
  if (error.status >= 500) {
    return new UpstreamFailure({
      message: error.message,
      status: error.status,
      type: error.type,
      accountId: error.accountId,
    });
  }
  return new ValidationFailure({
    message: error.message,
    param: error.param ?? null,
    code: error.code ?? null,
    status: error.status,
  });
}

export function routeErrorResponse(error: RouteError, format: ErrorFormat): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (error.accountId) headers.set("X-Provider-Account-Id", error.accountId);
  if (error.retryAfterMs != null && error.retryAfterMs > 0) {
    headers.set("Retry-After", String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
  }
  if (format === "anthropic") {
    const body: Record<string, unknown> = {
      type: error.type || "invalid_request_error",
      message: error.message,
    };
    if (error.retryAfter != null) body.retry_after = error.retryAfter;
    if (error.retryAfterMs != null) body.retry_after_ms = error.retryAfterMs;
    return new Response(JSON.stringify({ type: "error", error: body }), { status: error.status, headers });
  }
  const body = {
    error: {
      message: error.message,
      type: error.type || "invalid_request_error",
      param: error.param ?? null,
      code: error.code ?? null,
      ...(error.retryAfter != null ? { retry_after: error.retryAfter } : {}),
      ...(error.retryAfterMs != null ? { retry_after_ms: error.retryAfterMs } : {}),
    },
  };
  return new Response(JSON.stringify(body), { status: error.status, headers });
}

export function sanitizedProxyError(status: number, body: string): { message: string; type: string } {
  const type = providerErrorType(status);
  let message = extractProviderErrorDetail(body);
  if (!message) {
    message = statusText(status);
    if (!message) message = "Provider request failed";
  }
  return { message, type };
}

export function providerErrorType(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return "authentication_error";
    case 408:
      return "timeout_error";
    case 429:
      return "rate_limit_error";
    default:
      break;
  }
  if (status >= 500) return "api_error";
  if (status >= 400) return "invalid_request_error";
  return "api_error";
}

export function extractProviderErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const value = JSON.parse(trimmed) as unknown;
    const message = findMessage(value, 0);
    if (message) return normalizeClientError(message);
  } catch {
    return normalizeClientError(trimmed);
  }
  return normalizeClientError(trimmed);
}

function findMessage(value: unknown, depth: number): string {
  if (depth > 6 || value === null || value === undefined) return "";
  if (typeof value === "string") {
    try {
      const nested = JSON.parse(value) as unknown;
      const message = findMessage(nested, depth + 1);
      if (message) return message;
    } catch {
      return value;
    }
    return value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error_description", "error"]) {
      const message = findMessage(record[key], depth + 1);
      if (message) return message;
    }
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      return findMessage(record.errors[0], depth + 1);
    }
  }
  return "";
}

function normalizeClientError(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > 320) return `${normalized.slice(0, 320)}...[truncated]`;
  return normalized;
}

export function shouldRotate(status: number): boolean {
  return status >= 500 || [429, 408, 404, 403, 402, 401].includes(status);
}

export function isAntigravityResourceExhausted(provider: string, status: number, body: string): boolean {
  if (provider !== "antigravity" || status !== 429) return false;
  try {
    const payload = JSON.parse(body.trim()) as Record<string, unknown>;
    const error = payload.error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
    return stringValue((error as Record<string, unknown>).status).toLowerCase() === "resource_exhausted";
  } catch {
    return false;
  }
}

export function codexUsageLimitDisabledUntil(
  provider: string,
  status: number,
  body: string,
  now: Date
): Date | null {
  if (provider !== "codex" || status !== 429) return null;
  try {
    const payload = JSON.parse(body.trim()) as Record<string, unknown>;
    const error = payload.error;
    if (error === null || typeof error !== "object" || Array.isArray(error)) return null;
    const record = error as Record<string, unknown>;
    if (stringValue(record.type).trim() !== "usage_limit_reached") return null;
    const resetsAt = int64Value(record.resets_at);
    if (resetsAt !== null) {
      const until = new Date(resetsAt * 1000);
      if (until.getTime() > now.getTime()) return until;
    }
    const resetsIn = int64Value(record.resets_in_seconds);
    if (resetsIn !== null && resetsIn > 0) return new Date(now.getTime() + resetsIn * 1000);
    return null;
  } catch {
    return null;
  }
}

function int64Value(value: unknown): number | null {
  if (typeof value === "number" && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function retryMetadata(durationMs: number): { retryAfter: string | null; retryAfterMs: number | null } {
  if (durationMs <= 0) return { retryAfter: null, retryAfterMs: null };
  const ms = Math.max(1, Math.trunc(durationMs));
  let seconds = Math.trunc(durationMs / 1000);
  if (durationMs % 1000 !== 0) seconds += 1;
  if (seconds < 1) seconds = 1;
  return { retryAfter: `${seconds}s`, retryAfterMs: ms };
}

export function endpointPath(endpoint: string): string {
  switch (endpoint) {
    case "chat_completions":
      return "/v1/chat/completions";
    case "messages":
      return "/v1/messages";
    case "responses":
      return "/v1/responses";
    default:
      return `/${endpoint.replace(/^\/+/, "")}`;
  }
}

export function prefixWithProvider(providerName: string, message: string): string {
  if (!message) return message;
  if (!providerName) return message;
  return `[${providerName}] ${message}`;
}

const ACCOUNT_ERROR_TEXT_LIMIT = 200;
const ACCOUNT_ERROR_RAW_LIMIT = 2000;
const ACCOUNT_ERROR_ARRAY_PREVIEW = 10;
const ACCOUNT_ERROR_MESSAGE_LIMIT = 30;

export type AccountErrorContext = {
  model: string;
  provider: string;
  endpoint: string;
  messages: unknown;
  parameters: Record<string, unknown>;
};

export function buildAccountErrorMessage(errorMessage: string, context: AccountErrorContext): string {
  let truncatedError = errorMessage;
  if (truncatedError.length > ACCOUNT_ERROR_RAW_LIMIT) {
    truncatedError = `${truncatedError.slice(0, ACCOUNT_ERROR_RAW_LIMIT)}...[truncated, ${errorMessage.length} chars total]`;
  }

  let serializedParameters = "{}";
  try {
    serializedParameters = JSON.stringify(sanitizeParametersForError(context.parameters), null, 2);
  } catch {
    serializedParameters = '"[unserializable parameters]"';
  }

  const lines = [`Error: ${truncatedError}`];
  if (context.provider) lines.push(`Provider: ${context.provider}`);
  if (context.endpoint) lines.push(`Endpoint: ${context.endpoint}`);
  lines.push(`Model: ${context.model}`, `Parameters: ${serializedParameters}`);
  const summary = summarizeMessagesForError(context.messages);
  if (summary) lines.push(`Messages (object keys only): ${summary}`);
  return lines.join("\n");
}

function sanitizeParametersForError(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === "messages") {
      sanitized[key] = '[redacted: see "Messages (object keys only)"]';
      continue;
    }
    sanitized[key] = sanitizeValueForError(value, key);
  }
  return sanitized;
}

function sanitizeValueForError(value: unknown, key: string): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateAccountErrorString(value);
  if (Array.isArray(value)) {
    if (key === "tools") return summarizeToolsForError(value);
    const limit = Math.min(value.length, ACCOUNT_ERROR_ARRAY_PREVIEW);
    const items: unknown[] = [];
    for (let i = 0; i < limit; i += 1) items.push(sanitizeValueForError(value[i], key));
    if (value.length > ACCOUNT_ERROR_ARRAY_PREVIEW) {
      items.push(`...[truncated, ${value.length} items total]`);
    }
    return items;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeValueForError(v, k);
    }
    return out;
  }
  return value;
}

function truncateAccountErrorString(value: string): string {
  if (value.length <= ACCOUNT_ERROR_TEXT_LIMIT) return value;
  return `${value.slice(0, ACCOUNT_ERROR_TEXT_LIMIT)}...[truncated, ${value.length} chars total]`;
}

function summarizeToolsForError(tools: unknown[]): string {
  const names: string[] = [];
  const limit = Math.min(tools.length, ACCOUNT_ERROR_ARRAY_PREVIEW);
  for (const tool of tools.slice(0, limit)) {
    const toolMap = tool as Record<string, unknown>;
    if (toolMap.function !== null && typeof toolMap.function === "object") {
      const name = stringValue((toolMap.function as Record<string, unknown>).name);
      if (name) names.push(name);
      continue;
    }
    const name = stringValue(toolMap.name);
    if (name) names.push(name);
  }
  const suffix = tools.length > ACCOUNT_ERROR_ARRAY_PREVIEW ? `, +${tools.length - ACCOUNT_ERROR_ARRAY_PREVIEW} more` : "";
  return `[${tools.length} tool(s): ${names.join(", ")}${suffix}]`;
}

function summarizeMessagesForError(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const limit = Math.min(messages.length, ACCOUNT_ERROR_MESSAGE_LIMIT);
  const entries: Record<string, unknown>[] = [];
  for (let i = 0; i < limit; i += 1) {
    const entry: Record<string, unknown> = { index: i };
    const item = messages[i];
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      entry.keys = Object.keys(item as Record<string, unknown>).sort();
    } else if (Array.isArray(item)) {
      entry.type = "array";
    } else {
      entry.type = typeNameForError(item);
    }
    entries.push(entry);
  }
  if (messages.length > ACCOUNT_ERROR_MESSAGE_LIMIT) {
    entries.push({
      index: ACCOUNT_ERROR_MESSAGE_LIMIT,
      type: `truncated_${messages.length - ACCOUNT_ERROR_MESSAGE_LIMIT}_more_items`,
    });
  }
  try {
    return JSON.stringify(entries, null, 2);
  } catch {
    return "[unserializable message summary]";
  }
}

function typeNameForError(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "object";
}

function statusText(status: number): string {
  try {
    return new Response(null, { status }).statusText || "";
  } catch {
    return "";
  }
}
