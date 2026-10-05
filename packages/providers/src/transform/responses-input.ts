import {
  cloneAnyMap,
  contentToText,
  defaultEmpty,
  defaultStringValue,
  stringValue,
} from "#providers/lib/helpers.ts";
import { toResponsesApiId } from "#providers/transform/responses-core.ts";

type Json = Record<string, unknown>;

export function messagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    const content = normalizeResponsesContent(msg.content, role);
    switch (role) {
      case "system":
      case "developer":
        input.push({ type: "message", role: "developer", content });
        break;
      case "user":
        input.push({ type: "message", role: "user", content });
        break;
      case "assistant": {
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (calls.length > 0) {
          if (content != null && contentToText(content) !== "") {
            input.push({ type: "message", role: "assistant", content });
          }
          for (const rawCall of calls) {
            const call = (rawCall ?? {}) as Json;
            const fn = (call.function ?? {}) as Json;
            const name = stringValue(fn.name);
            if (!name) continue;
            const id = toResponsesApiId(stringValue(call.id));
            input.push({
              type: "function_call",
              id,
              call_id: id,
              name,
              arguments: defaultStringValue(fn.arguments, "{}"),
            });
          }
        } else {
          input.push({ type: "message", role: "assistant", content });
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: toResponsesApiId(stringValue(msg.tool_call_id)),
          output: contentToText(msg.content),
        });
        break;
      default:
        input.push({
          type: "message",
          role: defaultEmpty(role, "user"),
          content,
        });
    }
  }
  return input;
}

export function normalizeResponsesInput(input: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of input) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      out.push(raw);
      continue;
    }
    const item = cloneAnyMap(raw as Json);
    let type = stringValue(item.type);
    if (!type) {
      type = inferResponsesInputType(item);
      if (type) item.type = type;
    }
    if (type === "function_call") {
      const id = toResponsesApiId(defaultStringValue(item.id, stringValue(item.call_id)));
      item.id = id;
      item.call_id = id;
    }
    if (type === "function_call_output") {
      item.call_id = toResponsesApiId(stringValue(item.call_id));
    }
    if (type === "message") {
      item.content = normalizeResponsesContent(item.content, defaultStringValue(item.role, "user"));
    }
    out.push(item);
  }
  return out;
}

function inferResponsesInputType(item: Json): string {
  if ("summary" in item) return "reasoning";
  if ("encrypted_content" in item) return "reasoning";
  if (item.call_id !== undefined && item.name !== undefined) return "function_call";
  if (item.call_id !== undefined && item.output !== undefined) return "function_call_output";
  if (item.role !== undefined) return "message";
  return "";
}

export function normalizeResponsesContent(content: unknown, role: string): unknown {
  if (!Array.isArray(content)) return content;
  const targetTextType = role === "assistant" ? "output_text" : "input_text";
  const out: unknown[] = [];
  for (const raw of content) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      out.push(raw);
      continue;
    }
    const copy = cloneAnyMap(raw as Json);
    if (copy.type === "text") copy.type = targetTextType;
    if (copy.type === "image_url") {
      copy.type = "input_image";
      const imageUrl = copy.image_url;
      if (imageUrl !== null && typeof imageUrl === "object" && !Array.isArray(imageUrl)) {
        const image = imageUrl as Json;
        copy.image_url = stringValue(image.url);
        if (image.detail !== undefined) copy.detail = image.detail;
      }
    }
    out.push(copy);
  }
  return out;
}

export function convertToolsForResponses(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Json;
    let fn = (tool.function ?? {}) as Json;
    let name = stringValue(fn.name);
    if (!name) {
      name = stringValue(tool.name);
      fn = tool;
    }
    if (!name) continue;
    const params =
      fn.parameters !== null && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} };
    const converted: Json = {
      type: "function",
      name,
      description: defaultStringValue(fn.description, ""),
      parameters: params,
    };
    if (typeof fn.strict === "boolean") converted.strict = fn.strict;
    out.push(converted);
  }
  return out;
}
