import { defaultStringValue, randomId, stringValue } from "#providers/lib/helpers.ts";
import { toChatCallId } from "#providers/transform/responses-core.ts";
import { responseUsageToChatUsage } from "#providers/transform/responses-usage.ts";

type Json = Record<string, unknown>;

export function responsesJsonToChatCompletion(data: Json, model: string): Json {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const raw of output) {
    const item = (raw ?? {}) as Json;
    switch (item.type) {
      case "message": {
        const parts = Array.isArray(item.content) ? item.content : [];
        for (const rawPart of parts) {
          const part = (rawPart ?? {}) as Json;
          if (part.type === "output_text") content += stringValue(part.text);
        }
        break;
      }
      case "reasoning":
        reasoning += extractReasoningFromItem(item);
        break;
      case "function_call":
        toolCalls.push({
          id: toChatCallId(defaultStringValue(item.call_id, stringValue(item.id))),
          type: "function",
          function: {
            name: stringValue(item.name),
            arguments: defaultStringValue(item.arguments, "{}"),
          },
        });
        break;
      default:
        break;
    }
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  let finish = "stop";
  if (data.status === "incomplete") finish = "length";
  if (toolCalls.length > 0) finish = "tool_calls";
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: responseUsageToChatUsage(data.usage),
  };
}

function extractReasoningFromItem(item: Json): string {
  if (Array.isArray(item.summary)) {
    const text = joinReasoningParts(item.summary);
    if (text) return text;
  }
  if (Array.isArray(item.content)) {
    const text = joinReasoningParts(item.content);
    if (text) return text;
  }
  return stringValue(item.text);
}

function joinReasoningParts(parts: unknown[]): string {
  const chunks: string[] = [];
  for (const raw of parts) {
    if (typeof raw === "string") {
      if (raw) chunks.push(raw);
      continue;
    }
    const part = (raw ?? {}) as Json;
    const text = stringValue(part.text);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}
