import { Value } from "@opendum/providers/core/helpers";
import type { Json } from "@opendum/providers/upstreams/perch/auth";

export class PerchPayload {
  static text(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (const part of value) {
        const map = (part ?? {}) as Json;
        if (Value.string(map.type) === "text") {
          const text = Value.string(map.text);
          if (text) parts.push(text);
        }
      }
      return parts.join("\n");
    }
    return "";
  }

  static messages(body: Json): unknown[] {
    const out: unknown[] = [];
    const system = PerchPayload.text(body.system).trim();
    if (system) out.push({ role: "system", content: system });
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    for (const raw of rawMessages) {
      const message = (raw ?? {}) as Json;
      switch (Value.string(message.role)) {
        case "system":
        case "developer": {
          const text = PerchPayload.text(message.content).trim();
          if (text) out.push({ role: "system", content: text });
          break;
        }
        case "user":
          out.push({ role: "user", content: PerchPayload.text(message.content) });
          break;
        case "assistant": {
          const entry: Json = { role: "assistant", content: PerchPayload.text(message.content) };
          const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          if (calls.length > 0) {
            entry.tool_calls = calls.map((rawCall) => {
              const call = (rawCall ?? {}) as Json;
              const fn = (call.function ?? {}) as Json;
              return {
                id: Value.string(call.id),
                type: "function",
                function: {
                  name: Value.string(fn.name),
                  arguments: Value.string(fn.arguments) || "{}",
                },
              };
            });
          }
          out.push(entry);
          break;
        }
        case "tool":
          out.push({
            role: "tool",
            tool_call_id: Value.string(message.tool_call_id),
            content: PerchPayload.text(message.content),
          });
          break;
        default:
          break;
      }
    }
    return out;
  }

  static tools(body: Json): unknown[] | null {
    const rawTools = Array.isArray(body.tools) ? body.tools : [];
    if (rawTools.length === 0) return null;
    const out: Json[] = [];
    for (const raw of rawTools) {
      const tool = (raw ?? {}) as Json;
      const fn = (tool.function ?? {}) as Json;
      const name = Value.string(fn.name);
      if (!name) continue;
      const parameters = fn.parameters ?? { type: "object", properties: {} };
      const convertedFn: Json = { name, parameters };
      const description = Value.string(fn.description);
      if (description) convertedFn.description = description;
      out.push({ type: "function", function: convertedFn });
    }
    return out.length > 0 ? out : null;
  }
}
