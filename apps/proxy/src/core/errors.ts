import { stringValue } from "../providers/http.js";

export const accountErrorTextLimit = 200;
export const accountErrorRawMessageLimit = 2000;
export const accountErrorArrayPreviewLimit = 10;
export const accountErrorMessageLimit = 30;

export const providerDisplayNames: Record<string, string> = {
  antigravity: "Antigravity",
  codex: "Codex",
  command_code: "Command Code",
  kiro: "Kiro",
  nvidia_nim: "Nvidia",
  openrouter: "OpenRouter",
  workers_ai: "Cloudflare",
  qoder: "Qoder",
  zenmux: "ZenMux",
  siliconflow: "SiliconFlow",
  opencode: "Opencode",
  kilo_code: "Kilo Code",
  mimo_code: "MiMo Code",
};

export function providerDisplayName(provider: string): string {
  if (providerDisplayNames[provider]) return providerDisplayNames[provider]!;
  if (provider === "") return "";
  return provider;
}

export function prefixWithProvider(provider: string, message: string): string {
  if (message === "") return message;
  const name = providerDisplayName(provider);
  if (name === "") return message;
  return `[${name}] ${message}`;
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
  }
  if (status >= 500) return "api_error";
  if (status >= 400) return "invalid_request_error";
  return "api_error";
}

export function sanitizedProxyError(status: number, body: string): [string, string] {
  const typ = providerErrorType(status);
  let message = extractProviderErrorDetail(body);
  if (message === "") {
    message = httpStatusText(status);
    if (message === "") message = "Provider request failed";
  }
  return [message, typ];
}

function httpStatusText(status: number): string {
  const map: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    408: "Request Timeout",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return map[status] ?? "";
}

export function extractProviderErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (trimmed === "") return "";
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return normalizeClientError(trimmed);
  }
  const msg = findMessage(value, 0);
  if (msg !== "") return normalizeClientError(msg);
  return normalizeClientError(trimmed);
}

function findMessage(value: unknown, depth: number): string {
  if (depth > 6 || value === undefined || value === null) return "";
  if (typeof value === "string") {
    let nested: unknown;
    try {
      nested = JSON.parse(value);
    } catch {
      return value;
    }
    if (nested !== undefined && nested !== null && typeof nested === "object") {
      const msg = findMessage(nested, depth + 1);
      if (msg !== "") return msg;
    }
    return value;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const key of ["message", "detail", "error_description", "error"]) {
      const msg = findMessage(obj[key], depth + 1);
      if (msg !== "") return msg;
    }
    if (Array.isArray(obj["errors"]) && obj["errors"].length > 0) {
      return findMessage(obj["errors"][0], depth + 1);
    }
  }
  return "";
}

export function normalizeClientError(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length > 320) {
    return normalized.slice(0, 320) + "...[truncated]";
  }
  return normalized;
}

export function shouldRotate(status: number): boolean {
  return status >= 500 || status === 429 || status === 408 || status === 404 || status === 403 || status === 402 || status === 401;
}

export function isAntigravityResourceExhausted(provider: string, status: number, body: string): boolean {
  if (provider !== "antigravity" || status !== 429) return false;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.trim()) as Record<string, unknown>;
  } catch {
    return false;
  }
  const errorBody = payload["error"];
  if (!errorBody || typeof errorBody !== "object") return false;
  const statusValue = stringValue((errorBody as Record<string, unknown>)["status"]);
  return statusValue.trim().toLowerCase() === "RESOURCE_EXHAUSTED".toLowerCase();
}

export function codexUsageLimitDisabledUntil(provider: string, status: number, body: string, now: Date): [Date, boolean] {
  if (provider !== "codex" || status !== 429) return [new Date(0), false];
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.trim()) as Record<string, unknown>;
  } catch {
    return [new Date(0), false];
  }
  const errorBody = payload["error"];
  if (!errorBody || typeof errorBody !== "object") return [new Date(0), false];
  if (stringValue((errorBody as Record<string, unknown>)["type"]).trim() !== "usage_limit_reached") return [new Date(0), false];

  const resetsAt = int64Value((errorBody as Record<string, unknown>)["resets_at"]);
  if (resetsAt.ok) {
    const until = new Date(resetsAt.value * 1000);
    if (until.getTime() > now.getTime()) return [until, true];
  }
  const resetsInSeconds = int64Value((errorBody as Record<string, unknown>)["resets_in_seconds"]);
  if (resetsInSeconds.ok && resetsInSeconds.value > 0) {
    return [new Date(now.getTime() + resetsInSeconds.value * 1000), true];
  }
  return [new Date(0), false];
}

function int64Value(value: unknown): { ok: boolean; value: number } {
  if (typeof value === "number") return value > 0 ? { ok: true, value: Math.floor(value) } : { ok: false, value: 0 };
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    return !Number.isNaN(parsed) && parsed > 0 ? { ok: true, value: parsed } : { ok: false, value: 0 };
  }
  return { ok: false, value: 0 };
}

export function retryMetadata(durationMS: number): [string | null, number | null] {
  if (durationMS <= 0) return [null, null];
  let ms = Math.floor(durationMS);
  if (ms < 1) ms = 1;
  let seconds = Math.floor(durationMS / 1000);
  if (durationMS % 1000 !== 0) seconds++;
  if (seconds < 1) seconds = 1;
  return [`${seconds}s`, ms];
}

export function ptrIfNotEmpty(value: string): string | null {
  return value === "" ? null : value;
}

export interface AccountErrorContext {
  model: string;
  provider: string;
  endpoint: string;
  messages: unknown;
  parameters: Record<string, unknown>;
}

export function buildAccountErrorMessage(errorMessage: string, context: AccountErrorContext): string {
  let truncatedError = errorMessage;
  if (truncatedError.length > accountErrorRawMessageLimit) {
    truncatedError = truncatedError.slice(0, accountErrorRawMessageLimit) + `...[truncated, ${errorMessage.length} chars total]`;
  }

  let serializedParameters = "{}";
  try {
    serializedParameters = JSON.stringify(sanitizeParametersForError(context.parameters), null, 2);
  } catch {
    serializedParameters = `"[unserializable parameters]"`;
  }

  const lines = ["Error: " + truncatedError];
  if (context.provider !== "") lines.push("Provider: " + context.provider);
  if (context.endpoint !== "") lines.push("Endpoint: " + context.endpoint);
  lines.push("Model: " + context.model, "Parameters: " + serializedParameters);
  const summary = summarizeMessagesForError(context.messages);
  if (summary !== "") lines.push("Messages (object keys only): " + summary);
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
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return truncateAccountErrorString(value);
  if (Array.isArray(value)) {
    if (key === "tools") return summarizeToolsForError(value);
    let limit = value.length;
    let truncated = false;
    if (limit > accountErrorArrayPreviewLimit) {
      limit = accountErrorArrayPreviewLimit;
      truncated = true;
    }
    const items: unknown[] = [];
    for (let i = 0; i < limit; i++) {
      items.push(sanitizeValueForError(value[i], key));
    }
    if (truncated) {
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
  if (value.length <= accountErrorTextLimit) return value;
  return value.slice(0, accountErrorTextLimit) + `...[truncated, ${value.length} chars total]`;
}

function summarizeToolsForError(tools: unknown[]): string {
  const names: string[] = [];
  let limit = tools.length;
  if (limit > accountErrorArrayPreviewLimit) limit = accountErrorArrayPreviewLimit;
  for (const tool of tools.slice(0, limit)) {
    if (!tool || typeof tool !== "object") continue;
    const toolMap = tool as Record<string, unknown>;
    const fn = toolMap["function"];
    if (fn && typeof fn === "object") {
      const name = stringValue((fn as Record<string, unknown>)["name"]);
      if (name !== "") names.push(name);
      continue;
    }
    const name = stringValue(toolMap["name"]);
    if (name !== "") names.push(name);
  }
  let suffix = "";
  if (tools.length > accountErrorArrayPreviewLimit) {
    suffix = `, +${tools.length - accountErrorArrayPreviewLimit} more`;
  }
  return `[${tools.length} tool(s): ${names.join(", ")}${suffix}]`;
}

function summarizeMessagesForError(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const items = messages;
  let limit = items.length;
  if (limit > accountErrorMessageLimit) limit = accountErrorMessageLimit;
  const entries: Array<Record<string, unknown>> = [];
  for (let i = 0; i < limit; i++) {
    const entry: Record<string, unknown> = { index: i };
    if (items[i] && typeof items[i] === "object" && !Array.isArray(items[i])) {
      const obj = items[i] as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      entry["keys"] = keys;
    } else if (Array.isArray(items[i])) {
      entry["type"] = "array";
    } else {
      entry["type"] = typeNameForError(items[i]);
    }
    entries.push(entry);
  }
  if (items.length > accountErrorMessageLimit) {
    entries.push({ index: accountErrorMessageLimit, type: `truncated_${items.length - accountErrorMessageLimit}_more_items` });
  }
  try {
    return JSON.stringify(entries, null, 2);
  } catch {
    return "[unserializable message summary]";
  }
}

function typeNameForError(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "object";
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
      return "/" + endpoint.replace(/^\/+/, "");
  }
}

export function readBodyLimit(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return Promise.resolve("");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  return new Promise((resolve) => {
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        chunks.push(value);
        if (total >= limit) break;
      }
      const out = new Uint8Array(Math.min(total, limit));
      let offset = 0;
      for (const c of chunks) {
        const take = Math.min(c.length, limit - offset);
        out.set(c.subarray(0, take), offset);
        offset += take;
        if (offset >= limit) break;
      }
      resolve(new TextDecoder().decode(out));
    })();
  });
}
