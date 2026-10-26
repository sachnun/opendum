import { Coerce, Records } from "@opendum/api/core/helpers";

type Json = Record<string, unknown>;

export function toolsOf(tools: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of tools) {
    const tool = (raw ?? {}) as Json;
    if (tool.type === "namespace") {
      const name = Coerce.string(tool.name);
      for (const rawSub of Array.isArray(tool.tools) ? tool.tools : []) {
        const sub = (rawSub ?? {}) as Json;
        const fn = Records.clone(sub);
        delete fn.type;
        if (typeof fn.name === "string") fn.name = name + fn.name;
        out.push({ type: "function", function: fn });
      }
    } else if (tool.type === "function") {
      if (tool.function === undefined) {
        const fn = Records.clone(tool);
        delete fn.type;
        out.push({ type: "function", function: fn });
      } else {
        out.push(raw);
      }
    }
  }
  return out;
}

export function contentOf(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const out: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    const copyPart = Records.clone(part);
    switch (copyPart.type) {
      case "input_text":
      case "output_text":
        copyPart.type = "text";
        break;
      case "input_image":
        copyPart.type = "image_url";
        if (typeof copyPart.image_url === "string") {
          copyPart.image_url = { url: copyPart.image_url };
        }
        break;
      default:
        break;
    }
    out.push(copyPart);
  }
  return out;
}

export function toMessages(input: unknown[], instructions: string): unknown[] {
  const messages: unknown[] = [];
  if (instructions) messages.push({ role: "system", content: instructions });
  let pendingToolCalls: Json[] = [];
  let pendingReasoning = "";
  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    const message: Json = { role: "assistant", content: "", tool_calls: pendingToolCalls };
    if (pendingReasoning) {
      message.reasoning_content = pendingReasoning;
      pendingReasoning = "";
    }
    messages.push(message);
    pendingToolCalls = [];
  };
  for (const raw of input) {
    const item = (raw ?? {}) as Json;
    switch (typeOf(item)) {
      case "message": {
        flushToolCalls();
        let role = Coerce.string(item.role);
        if (role === "developer") role = "system";
        if (!role) role = "user";
        const message: Json = { role, content: contentOf(item.content) };
        if (role === "assistant" && pendingReasoning) {
          message.reasoning_content = pendingReasoning;
          pendingReasoning = "";
        }
        messages.push(message);
        break;
      }
      case "reasoning": {
        const text = reasonText(item);
        if (text) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n\n${text}` : text;
        break;
      }
      case "function_call": {
        let id = Coerce.string(item.call_id) || Coerce.string(item.id) || "call_generated";
        id = callId(id);
        pendingToolCalls.push({
          id,
          type: "function",
          function: { name: Coerce.string(item.name), arguments: Coerce.string(item.arguments) || "{}" },
        });
        break;
      }
      case "function_call_output":
        flushToolCalls();
        messages.push({
          role: "tool",
          content: outputOf(item.output),
          tool_call_id: callId(Coerce.string(item.call_id)),
        });
        break;
      default:
        break;
    }
  }
  flushToolCalls();
  return messages;
}

export function typeOf(item: Json): string {
  const type = Coerce.string(item.type);
  if (type) return type;
  if ("summary" in item) return "reasoning";
  if ("encrypted_content" in item) return "reasoning";
  if (item.call_id != null && item.name != null) return "function_call";
  if (item.call_id != null && item.output != null) return "function_call_output";
  if (item.role != null) return "message";
  return "";
}

export function reasonText(item: Json): string {
  const parts: string[] = [];
  for (const collection of [item.summary, item.content]) {
    if (!Array.isArray(collection)) continue;
    for (const raw of collection) {
      const text = partText(raw);
      if (text) parts.push(text);
    }
  }
  if (parts.length === 0) {
    const text = Coerce.string(item.text);
    if (text) return text;
  }
  return parts.join("\n\n");
}

export function partText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return Coerce.string((raw as Json).text);
  }
  return "";
}

export function outputOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const raw of value) {
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const text = Coerce.string((raw as Json).text);
        if (text) chunks.push(text);
      }
    }
    return chunks.join("\n");
  }
  return "";
}

export function callId(id: string): string {
  if (id.length > 3 && (id.startsWith("fc_") || id.startsWith("fc-"))) {
    return `call_${id.slice(3)}`;
  }
  return id;
}

