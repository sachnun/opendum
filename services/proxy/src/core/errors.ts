import { stringValue } from "./helpers.js";
import type { ErrorFormat, RouteError } from "./types.js";

export function writeRouteError(
  format: ErrorFormat,
  error: RouteError
): Response {
  const type = error.type || "invalid_request_error";
  const headers = new Headers({ "Content-Type": "application/json" });
  if (format === "anthropic") {
    const body: Record<string, unknown> = { type, message: error.message };
    if (error.retryAfter != null) body.retry_after = error.retryAfter;
    if (error.retryAfterMs != null) body.retry_after_ms = error.retryAfterMs;
    return new Response(JSON.stringify({ type: "error", error: body }), {
      status: error.status,
      headers,
    });
  }
  const body = {
    error: {
      message: error.message,
      type,
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
