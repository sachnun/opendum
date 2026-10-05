import { numberFromAny, parseSseDataLines, stringValue } from "#providers/lib/helpers.ts";
import { responsesJsonToChatCompletion } from "#providers/transform/responses.ts";

type Json = Record<string, unknown>;

export function responsesStreamToCompletion(text: string, model: string): Json {
  const events = parseSseDataLines(text);
  const completion: Json = { output: [], usage: {} };
  let messageContent = "";
  const reasoningParts = new Map<string, string>();
  const reasoningOrder: string[] = [];
  const appendReasoning = (key: string, part: string): void => {
    if (!part) return;
    const existing = reasoningParts.get(key) ?? "";
    let missing = part;
    if (part.startsWith(existing)) missing = part.slice(existing.length);
    if (!missing) return;
    if (!reasoningParts.has(key)) reasoningOrder.push(key);
    reasoningParts.set(key, existing + missing);
  };
  const addReasoningItem = (item: Json): void => {
    if (Array.isArray(item.summary) && item.summary.length > 0) {
      item.summary.forEach((raw, index) => {
        const value = typeof raw === "string" ? raw : stringValue((raw as Json)?.text);
        if (value) appendReasoning(`summary:${index}`, value);
      });
      return;
    }
    if (Array.isArray(item.content) && item.content.length > 0) {
      item.content.forEach((raw, index) => {
        const value = stringValue((raw as Json)?.text);
        if (value) appendReasoning(`text:${index}`, value);
      });
      return;
    }
    const textValue = stringValue(item.text);
    if (textValue) appendReasoning("text:0", textValue);
  };

  const toolCalls: Json[] = [];
  let currentTool: Json | null = null;
  for (const event of events) {
    switch (stringValue(event.type)) {
      case "response.output_text.delta":
        messageContent += stringValue(event.delta);
        break;
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
        appendReasoning(`text:${numberFromAny(event.content_index)}`, stringValue(event.delta));
        break;
      case "response.reasoning_summary_text.delta":
        appendReasoning(`summary:${numberFromAny(event.summary_index)}`, stringValue(event.delta));
        break;
      case "response.reasoning_text.done":
        appendReasoning(`text:${numberFromAny(event.content_index)}`, stringValue(event.text));
        break;
      case "response.reasoning_summary_text.done":
        appendReasoning(`summary:${numberFromAny(event.summary_index)}`, stringValue(event.text));
        break;
      case "response.reasoning_summary_part.done": {
        const part = (event.part ?? {}) as Json;
        let value = stringValue(part.text);
        if (!value) value = stringValue(event.text);
        appendReasoning(`summary:${numberFromAny(event.summary_index)}`, value);
        break;
      }
      case "response.output_item.added": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "function_call") {
          currentTool = {
            type: "function_call",
            id: item.id,
            call_id: item.call_id,
            name: item.name,
            arguments: "",
          };
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta":
        if (currentTool) {
          currentTool.arguments = stringValue(currentTool.arguments) + stringValue(event.delta);
        }
        break;
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "reasoning") addReasoningItem(item);
        if (currentTool) {
          toolCalls.push(currentTool);
          currentTool = null;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = (event.response ?? event) as Json;
        completion.status = response.status;
        completion.usage = response.usage;
        break;
      }
      default:
        break;
    }
  }

  const output: unknown[] = [];
  if (messageContent) {
    output.push({ type: "message", content: [{ type: "output_text", text: messageContent }] });
  }
  const reasoningText = reasoningOrder
    .map((key) => reasoningParts.get(key) ?? "")
    .filter((value) => value)
    .join("\n\n");
  if (reasoningText) output.push({ type: "reasoning", text: reasoningText });
  output.push(...toolCalls);
  completion.output = output;
  return responsesJsonToChatCompletion(completion, model);
}
