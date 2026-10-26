import {
  ARRAY_PREVIEW_LIMIT,
  ERROR_MESSAGE_LIMIT,
  RAW_MESSAGE_LIMIT,
  ERROR_STRING_LIMIT,
  type PlaygroundEndpoint,
} from "~~/lib/playground/types";

export class ErrorText {
  static fromResponse(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "Request failed";
    try {
      const parsed = JSON.parse(trimmed);
      const error = (parsed as { error?: { message?: unknown } } | null)?.error;
      if (error && typeof error === "object" && typeof error.message === "string") return error.message;
      if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
        return (parsed as { message: string }).message;
      }
    } catch {
      return trimmed;
    }
    return trimmed;
  }

  static truncate(value: string): string {
    if (value.length <= ERROR_STRING_LIMIT) return value;
    return `${value.slice(0, ERROR_STRING_LIMIT)}...[truncated, ${value.length} chars total]`;
  }

  static summarizeTools(tools: unknown[]): string {
    const names: string[] = [];
    const limit = Math.min(tools.length, ARRAY_PREVIEW_LIMIT);
    for (let i = 0; i < limit; i += 1) {
      const tool = tools[i];
      if (!tool || typeof tool !== "object") continue;
      const fn = (tool as { function?: unknown }).function;
      if (fn && typeof fn === "object") {
        if (typeof (fn as { name?: unknown }).name === "string") names.push((fn as { name: string }).name);
        continue;
      }
      if (typeof (tool as { name?: unknown }).name === "string") names.push((tool as { name: string }).name);
    }
    const suffix =
      tools.length > ARRAY_PREVIEW_LIMIT ? `, +${tools.length - ARRAY_PREVIEW_LIMIT} more` : "";
    return `[${tools.length} tool(s): ${names.join(", ")}${suffix}]`;
  }

  static sanitize(value: unknown, key: string): unknown {
    if (typeof value === "string") return ErrorText.truncate(value);
    if (Array.isArray(value)) {
      if (key === "tools") return ErrorText.summarizeTools(value);
      const items = value
        .slice(0, ARRAY_PREVIEW_LIMIT)
        .map((item) => ErrorText.sanitize(item, key));
      if (value.length > ARRAY_PREVIEW_LIMIT) {
        items.push(`...[truncated, ${value.length} items total]`);
      }
      return items;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        out[nestedKey] = ErrorText.sanitize(nestedValue, nestedKey);
      }
      return out;
    }
    return value;
  }

  static parameters(parameters: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parameters)) {
      out[key] =
        key === "messages"
          ? '[redacted: see "Messages (object keys only)"]'
          : ErrorText.sanitize(value, key);
    }
    return out;
  }

  static typeName(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    return "object";
  }

  static summarizeMessages(messages: unknown): string {
    if (!Array.isArray(messages)) return "";
    const entries: Array<Record<string, unknown>> = [];
    const limit = Math.min(messages.length, ERROR_MESSAGE_LIMIT);
    for (let i = 0; i < limit; i += 1) {
      const item = messages[i];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        entries.push({ index: i, keys: Object.keys(item as Record<string, unknown>).sort() });
      } else if (Array.isArray(item)) {
        entries.push({ index: i, type: "array" });
      } else {
        entries.push({ index: i, type: ErrorText.typeName(item) });
      }
    }
    if (messages.length > ERROR_MESSAGE_LIMIT) {
      entries.push({
        index: ERROR_MESSAGE_LIMIT,
        type: `truncated_${messages.length - ERROR_MESSAGE_LIMIT}_more_items`,
      });
    }
    return JSON.stringify(entries, null, 2);
  }

  static path(endpoint: PlaygroundEndpoint): string {
    if (endpoint === "messages") return "/v1/messages";
    if (endpoint === "responses") return "/v1/responses";
    return "/v1/chat/completions";
  }

  static build(
    message: string,
    context: {
      model: string;
      provider: string | null;
      endpoint: PlaygroundEndpoint;
      parameters: Record<string, unknown> | null;
      messages: unknown;
    }
  ): string {
    const truncated =
      message.length > RAW_MESSAGE_LIMIT
        ? `${message.slice(0, RAW_MESSAGE_LIMIT)}...[truncated, ${message.length} chars total]`
        : message;

    let serializedParameters = "{}";
    if (context.parameters) {
      try {
        serializedParameters = JSON.stringify(ErrorText.parameters(context.parameters), null, 2);
      } catch {
        serializedParameters = '"[unserializable parameters]"';
      }
    }

    const lines = [`Error: ${truncated}`];
    if (context.provider) lines.push(`Provider: ${context.provider}`);
    lines.push(
      `Endpoint: ${ErrorText.path(context.endpoint)}`,
      `Model: ${context.model}`,
      `Parameters: ${serializedParameters}`
    );
    const summary = ErrorText.summarizeMessages(context.messages);
    if (summary) lines.push(`Messages (object keys only): ${summary}`);
    return lines.join("\n");
  }
}
