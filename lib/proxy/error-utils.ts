export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown error";
    }
  }

  return "Unknown error";
}

export function getErrorStatusCode(error: unknown): number {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return status;
    }

    const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
    if (
      typeof responseStatus === "number" &&
      responseStatus >= 400 &&
      responseStatus <= 599
    ) {
      return responseStatus;
    }

    const code = (error as { code?: unknown }).code;
    if (typeof code === "number" && code >= 400 && code <= 599) {
      return code;
    }
  }

  const message = getErrorMessage(error);
  const statusMatch = message.match(/\b(?:HTTP\s*)?([45]\d{2})\b/i);
  if (statusMatch) {
    return Number(statusMatch[1]);
  }

  return 500;
}

const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_SUMMARY_ITEMS = 10;

/**
 * Truncate a string to a max length, appending "[truncated]" if it exceeds.
 */
function truncateString(value: string, maxLength: number = MAX_STRING_LENGTH): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + `...[truncated, ${value.length} chars total]`;
}

/**
 * Summarize a tools array: show count + function names only.
 */
function summarizeTools(tools: unknown[]): string {
  const names: string[] = [];
  for (const tool of tools.slice(0, MAX_ARRAY_SUMMARY_ITEMS)) {
    if (tool && typeof tool === "object") {
      const t = tool as Record<string, unknown>;
      // OpenAI format: { type: "function", function: { name, ... } }
      if (t.function && typeof t.function === "object") {
        const fn = t.function as Record<string, unknown>;
        if (typeof fn.name === "string") names.push(fn.name);
      }
      // Anthropic format: { name, ... }
      else if (typeof t.name === "string") {
        names.push(t.name);
      }
    }
  }
  const suffix = tools.length > MAX_ARRAY_SUMMARY_ITEMS
    ? `, +${tools.length - MAX_ARRAY_SUMMARY_ITEMS} more`
    : "";
  return `[${tools.length} tool(s): ${names.join(", ")}${suffix}]`;
}

/**
 * Deep-sanitize a value for error logging.
 * - Strings longer than maxLength are truncated
 * - Arrays of tools are summarized
 * - Other arrays show count + item type summary
 * - Objects are recursively sanitized
 */
function sanitizeValue(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (Array.isArray(value)) {
    // Tools arrays get special summary treatment
    if (key === "tools") {
      return summarizeTools(value);
    }

    // Other arrays: show count + summarized items
    if (value.length > MAX_ARRAY_SUMMARY_ITEMS) {
      const preview = value.slice(0, MAX_ARRAY_SUMMARY_ITEMS).map((item, i) => sanitizeValue(item, `${key}[${i}]`));
      return [...preview, `...[truncated, ${value.length} items total]`];
    }

    return value.map((item, i) => sanitizeValue(item, `${key}[${i}]`));
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      sanitized[k] = sanitizeValue(v, k);
    }
    return sanitized;
  }

  // numbers, booleans, etc.
  return value;
}

/**
 * Sanitize the parameters object for error storage.
 * Truncates long strings, summarizes tools arrays, and redacts large nested content.
 */
function sanitizeParametersForError(params: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;

    // Messages are handled separately via summarizeMessages
    if (key === "messages") {
      sanitized[key] = "[redacted: see \"Messages (object keys only)\"]";
      continue;
    }

    sanitized[key] = sanitizeValue(value, key);
  }

  return sanitized;
}

export function buildAccountErrorMessage(
  errorMessage: string,
  context: {
    model: string;
    provider?: string;
    endpoint?: string;
    messages?: unknown;
    parameters?: Record<string, unknown>;
  }
): string {
  // Truncate the raw error message itself (can be huge from provider response body)
  const truncatedError = errorMessage.length > 2000
    ? errorMessage.slice(0, 2000) + `...[truncated, ${errorMessage.length} chars total]`
    : errorMessage;

  const sanitizedParameters = sanitizeParametersForError(context.parameters ?? {});

  const summarizeMessages = (messages: unknown): string | null => {
    if (!Array.isArray(messages)) {
      return null;
    }

    const maxEntries = 30;
    const entries = messages.slice(0, maxEntries).map((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return {
          index,
          keys: Object.keys(item as Record<string, unknown>),
        };
      }

      return {
        index,
        type: Array.isArray(item) ? "array" : typeof item,
      };
    });

    if (messages.length > maxEntries) {
      entries.push({
        index: maxEntries,
        type: `truncated_${messages.length - maxEntries}_more_items`,
      });
    }

    try {
      return JSON.stringify(entries, null, 2);
    } catch {
      return "[unserializable message summary]";
    }
  };

  const messageSummary = summarizeMessages(context.messages);

  let serializedParameters = "{}";
  try {
    serializedParameters = JSON.stringify(sanitizedParameters, null, 2);
  } catch {
    serializedParameters = '"[unserializable parameters]"';
  }

  return [
    `Error: ${truncatedError}`,
    context.provider ? `Provider: ${context.provider}` : null,
    context.endpoint ? `Endpoint: ${context.endpoint}` : null,
    `Model: ${context.model}`,
    `Parameters: ${serializedParameters}`,
    messageSummary
      ? `Messages (object keys only): ${messageSummary}`
      : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function shouldRotateToNextAccount(statusCode: number): boolean {
  return (
    statusCode >= 500 ||
    statusCode === 429 ||
    statusCode === 408 ||
    statusCode === 403 ||
    statusCode === 402 ||
    statusCode === 401
  );
}

export type ProxyErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "api_error";

export function getSanitizedProxyError(statusCode: number): {
  type: ProxyErrorType;
  message: string;
} {
  if (statusCode === 400 || statusCode === 422) {
    return {
      type: "invalid_request_error",
      message: "Invalid request parameters.",
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      type: "authentication_error",
      message: "Provider authentication failed. Please re-authenticate your account.",
    };
  }

  if (statusCode === 408) {
    return {
      type: "api_error",
      message: "Provider request timed out. Please retry.",
    };
  }

  if (statusCode === 429) {
    return {
      type: "rate_limit_error",
      message: "Provider rate limit reached. Please retry shortly.",
    };
  }

  if (statusCode >= 500) {
    return {
      type: "api_error",
      message: "Provider service temporarily unavailable.",
    };
  }

  return {
    type: "api_error",
    message: `Provider request failed (HTTP ${statusCode}).`,
  };
}
