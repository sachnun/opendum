import { Coerce, Safe } from "@opendum/api/core/helpers";

const TEXT_LIMIT = 200;
const RAW_LIMIT = 2000;
const ARRAY_PREVIEW = 10;
const MESSAGE_LIMIT = 30;

export type AccountErrorContext = {
  model: string;
  provider: string;
  endpoint: string;
  messages: unknown;
  parameters: Record<string, unknown>;
};

export class AccountError {
  static build(errorMessage: string, context: AccountErrorContext): string {
    let truncatedError = errorMessage;
    if (truncatedError.length > RAW_LIMIT) {
      truncatedError = `${truncatedError.slice(0, RAW_LIMIT)}...[truncated, ${errorMessage.length} chars total]`;
    }

    const serializedParameters = Safe.sync(
      () =>
        JSON.stringify(AccountError.parameters(context.parameters), null, 2) ??
        '"[unserializable parameters]"',
      '"[unserializable parameters]"'
    );

    const lines = [`Error: ${truncatedError}`];
    if (context.provider) lines.push(`Provider: ${context.provider}`);
    if (context.endpoint) lines.push(`Endpoint: ${context.endpoint}`);
    lines.push(`Model: ${context.model}`, `Parameters: ${serializedParameters}`);
    const summary = AccountError.messages(context.messages);
    if (summary) lines.push(`Messages (object keys only): ${summary}`);
    return lines.join("\n");
  }

  private static parameters(params: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key === "messages") {
        sanitized[key] = '[redacted: see "Messages (object keys only)"]';
        continue;
      }
      sanitized[key] = AccountError.value(value, key);
    }
    return sanitized;
  }

  private static value(value: unknown, key: string): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return AccountError.truncate(value);
    if (Array.isArray(value)) {
      if (key === "tools") return AccountError.tools(value);
      const limit = Math.min(value.length, ARRAY_PREVIEW);
      const items: unknown[] = [];
      for (let i = 0; i < limit; i += 1) items.push(AccountError.value(value[i], key));
      if (value.length > ARRAY_PREVIEW) {
        items.push(`...[truncated, ${value.length} items total]`);
      }
      return items;
    }
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = AccountError.value(v, k);
      }
      return out;
    }
    return value;
  }

  private static truncate(value: string): string {
    if (value.length <= TEXT_LIMIT) return value;
    return `${value.slice(0, TEXT_LIMIT)}...[truncated, ${value.length} chars total]`;
  }

  private static tools(tools: unknown[]): string {
    const names: string[] = [];
    const limit = Math.min(tools.length, ARRAY_PREVIEW);
    for (const tool of tools.slice(0, limit)) {
      const map = tool as Record<string, unknown>;
      if (map.function !== null && typeof map.function === "object") {
        const name = Coerce.string((map.function as Record<string, unknown>).name);
        if (name) names.push(name);
        continue;
      }
      const name = Coerce.string(map.name);
      if (name) names.push(name);
    }
    const suffix = tools.length > ARRAY_PREVIEW ? `, +${tools.length - ARRAY_PREVIEW} more` : "";
    return `[${tools.length} tool(s): ${names.join(", ")}${suffix}]`;
  }

  private static messages(messages: unknown): string {
    if (!Array.isArray(messages)) return "";
    const limit = Math.min(messages.length, MESSAGE_LIMIT);
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < limit; i += 1) {
      const entry: Record<string, unknown> = { index: i };
      const item = messages[i];
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        entry.keys = Object.keys(item as Record<string, unknown>).sort();
      } else if (Array.isArray(item)) {
        entry.type = "array";
      } else {
        entry.type = AccountError.typeName(item);
      }
      entries.push(entry);
    }
    if (messages.length > MESSAGE_LIMIT) {
      entries.push({
        index: MESSAGE_LIMIT,
        type: `truncated_${messages.length - MESSAGE_LIMIT}_more_items`,
      });
    }
    return Safe.sync(
      () => JSON.stringify(entries, null, 2) ?? "[unserializable message summary]",
      "[unserializable message summary]"
    );
  }

  private static typeName(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "number";
    return "object";
  }
}
