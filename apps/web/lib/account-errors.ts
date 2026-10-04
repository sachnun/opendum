export type ParsedErrorDetails = {
  error: string | null;
  provider: string | null;
  endpoint: string | null;
  model: string | null;
  parameters: string | null;
  messageObjects: string[] | null;
};

export type ErrorStatusTag = {
  code: number;
  label: string;
};

export type ErrorPlaygroundEndpoint = "chat_completions" | "messages" | "responses";

export const HTTP_STATUS_DESCRIPTIONS: Record<number, string> = {
  100: "Continue",
  101: "Switching Protocols",
  102: "Processing",
  103: "Early Hints",
  200: "OK",
  201: "Created",
  202: "Accepted",
  203: "Non-Authoritative Information",
  204: "No Content",
  205: "Reset Content",
  206: "Partial Content",
  207: "Multi-Status",
  208: "Already Reported",
  226: "IM Used",
  300: "Multiple Choices",
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  304: "Not Modified",
  305: "Use Proxy",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  407: "Proxy Authentication Required",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  417: "Expectation Failed",
  418: "I'm a Teapot",
  421: "Misdirected Request",
  422: "Unprocessable Content",
  423: "Locked",
  424: "Failed Dependency",
  425: "Too Early",
  426: "Upgrade Required",
  428: "Precondition Required",
  429: "Rate Limit",
  431: "Request Header Fields Too Large",
  451: "Unavailable For Legal Reasons",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  505: "HTTP Version Not Supported",
  506: "Variant Also Negotiates",
  507: "Insufficient Storage",
  508: "Loop Detected",
  510: "Not Extended",
  511: "Network Authentication Required",
};

export function parseStoredErrorMessage(rawMessage: string, code: number | null | undefined): ParsedErrorDetails {
  const sections: Record<"error" | "provider" | "endpoint" | "model" | "parameters" | "messages", string[]> = {
    error: [],
    provider: [],
    endpoint: [],
    model: [],
    parameters: [],
    messages: [],
  };

  const labels: Array<{ key: keyof typeof sections; prefix: string }> = [
    { key: "error", prefix: "Error:" },
    { key: "provider", prefix: "Provider:" },
    { key: "endpoint", prefix: "Endpoint:" },
    { key: "model", prefix: "Model:" },
    { key: "parameters", prefix: "Parameters:" },
    { key: "messages", prefix: "Messages (object keys only):" },
  ];

  let currentKey: keyof typeof sections | null = null;

  for (const line of rawMessage.split("\n")) {
    const matchedLabel = labels.find((label) => line.startsWith(label.prefix));
    if (matchedLabel) {
      currentKey = matchedLabel.key;
      const initialValue = line.slice(matchedLabel.prefix.length).trimStart();
      if (initialValue) sections[currentKey].push(initialValue);
      continue;
    }

    if (currentKey) sections[currentKey].push(line);
  }

  const parsedMessageObjects = (() => {
    const rawMessages = sections.messages.join("\n").trim();
    if (!rawMessages) return null;

    try {
      const parsed = JSON.parse(rawMessages) as Array<{
        index?: number;
        keys?: unknown;
        type?: unknown;
      }>;

      if (!Array.isArray(parsed)) return null;

      return parsed.map((entry) => {
        if (typeof entry.index !== "number") return null;
        if (Array.isArray(entry.keys)) {
          const normalizedKeys = entry.keys.filter((value): value is string => typeof value === "string");
          return `#${entry.index}: ${normalizedKeys.length > 0 ? normalizedKeys.join(", ") : "(no keys)"}`;
        }

        if (typeof entry.type === "string") return `#${entry.index}: (${entry.type})`;

        return `#${entry.index}: (unknown)`;
      }).filter((entry): entry is string => entry !== null);
    } catch {
      return rawMessages
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    }
  })();

  return {
    error: stripStatusFromErrorMessage(sections.error.join("\n"), code) || null,
    provider: sections.provider.join("\n").trim() || null,
    endpoint: sections.endpoint.join("\n").trim() || null,
    model: sections.model.join("\n").trim() || null,
    parameters: sections.parameters.join("\n").trim() || null,
    messageObjects: parsedMessageObjects,
  };
}

export function getHttpStatusDescription(code: number): string {
  return HTTP_STATUS_DESCRIPTIONS[code] ?? "HTTP Error";
}

export function getErrorStatusTag(code: number | null | undefined): ErrorStatusTag | null {
  return code ? { code, label: getHttpStatusDescription(code) } : null;
}

export function stripStatusFromErrorMessage(message: string, code: number | null | undefined): string {
  const trimmed = message.trimStart().replace(/^Error:\s*/i, "");
  if (!code) return trimmed;

  return trimmed
    .replace(new RegExp(`^\\[${code}\\]\\s*(?:error:\\s*)?`, "i"), "")
    .replace(new RegExp(`^HTTP\\s+${code}\\s*[:\\-]?\\s*(?:error:\\s*)?`, "i"), "")
    .replace(/^Error:\s*/i, "")
    .trimStart();
}

export function getErrorMessageModel(message: string, code: number | null | undefined): string | null {
  return parseStoredErrorMessage(message, code).model?.trim() || null;
}

export function normalizePlaygroundEndpoint(value: string | null | undefined): ErrorPlaygroundEndpoint | null {
  const normalized = value?.trim().replace(/^\/v1\//, "") ?? "";
  if (normalized === "chat/completions" || normalized === "chat_completions") return "chat_completions";
  if (normalized === "messages") return "messages";
  if (normalized === "responses") return "responses";
  return null;
}

export function parseErrorParameters(value: string | null | undefined): Record<string, unknown> | null {
  if (!value?.trim()) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function addPlaygroundParam(query: Record<string, string>, params: Record<string, unknown>, targetKey: string, sourceKeys: string[] = []) {
  for (const key of [targetKey, ...sourceKeys]) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      query[targetKey] = value.trim();
      return;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      query[targetKey] = String(value);
      return;
    }
    if (typeof value === "boolean") {
      query[targetKey] = String(value);
      return;
    }
  }
}

export function addAdditionalPlaygroundParams(query: Record<string, string>, params: Record<string, unknown>) {
  const handledKeys = new Set([
    "stream",
    "temperature",
    "top_p",
    "max_tokens",
    "max_output_tokens",
    "max_completion_tokens",
    "presence_penalty",
    "frequency_penalty",
    "reasoning_effort",
  ]);
  const additionalParams = Object.fromEntries(Object.entries(params).filter(([key]) => !handledKeys.has(key)));
  if (Object.keys(additionalParams).length > 0) query.additional_parameters = JSON.stringify(additionalParams);
}

export function isImmediatelyRecoverableErrorCode(code: number | null | undefined): boolean {
  if (!code) return false;
  return code === 408 || code === 429 || (code >= 500 && code <= 599);
}
