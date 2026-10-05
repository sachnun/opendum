import { defaultStringValue, numberFromAny, randomId, stringValue } from "#providers/lib/helpers.ts";
import { sseDataLines } from "#providers/lib/sse.ts";
import { toChatCallId } from "#providers/transform/responses-core.ts";
import { responseUsageToChatUsage } from "#providers/transform/responses-usage.ts";

export { responsesJsonToChatCompletion } from "#providers/transform/responses-json.ts";
export { responseUsageToChatUsage } from "#providers/transform/responses-usage.ts";

type Json = Record<string, unknown>;

function toStream(events: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

class ReasoningParts {
  private readonly parts = new Map<string, string>();
  private readonly order: string[] = [];

  append(key: string, text: string): { missing: string; isNewPart: boolean } {
    if (!text) return { missing: "", isNewPart: false };
    const existing = this.parts.get(key) ?? "";
    let missing = text;
    if (text.startsWith(existing)) missing = text.slice(existing.length);
    if (!missing) return { missing: "", isNewPart: false };
    const seen = this.parts.has(key);
    this.parts.set(key, existing + missing);
    if (!seen) this.order.push(key);
    return { missing, isNewPart: !seen };
  }

  text(): string {
    const chunks: string[] = [];
    for (const key of this.order) {
      const value = this.parts.get(key);
      if (value) chunks.push(value);
    }
    return chunks.join("\n\n");
  }

  addItem(item: Json, emit: (key: string, text: string) => void): void {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    if (summary.length > 0) {
      summary.forEach((raw, index) => {
        let text = "";
        if (typeof raw === "string") text = raw;
        else if (raw !== null && typeof raw === "object") text = stringValue((raw as Json).text);
        if (text) emit(reasoningKey("summary", index), text);
      });
      return;
    }
    const content = Array.isArray(item.content) ? item.content : [];
    if (content.length > 0) {
      content.forEach((raw, index) => {
        const part = (raw ?? {}) as Json;
        const text = stringValue(part.text);
        if (text) emit(reasoningKey("text", index), text);
      });
      return;
    }
    const text = stringValue(item.text);
    if (text) emit(reasoningKey("text", 0), text);
  }
}

function reasoningKey(family: string, index: unknown): string {
  return `${family}:${numberFromAny(index)}`;
}

async function* transformResponsesSseToChat(
  source: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<string> {
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  let toolIndex = 0;
  const reasoning = new ReasoningParts();
  let reasoningEmitted = false;

  const writeChunk = (delta: Json, finish: unknown, usage?: Json): string => {
    const chunk: Json = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  const emitReasoning = (key: string, text: string): string[] => {
    const { missing, isNewPart } = reasoning.append(key, text);
    if (!missing) return [];
    const prefix = isNewPart && reasoningEmitted ? "\n\n" : "";
    reasoningEmitted = true;
    const out: string[] = [];
    if (!sentRole) {
      out.push(writeChunk({ role: "assistant", content: "" }, null));
      sentRole = true;
    }
    out.push(writeChunk({ reasoning_content: prefix + missing }, null));
    return out;
  };

  for await (const data of sseDataLines(source)) {
    if (!data || data === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const type = stringValue(event.type);
    switch (type) {
      case "response.output_text.delta": {
        if (!sentRole) {
          yield writeChunk({ role: "assistant", content: "" }, null);
          sentRole = true;
        }
        const delta = stringValue(event.delta);
        if (delta) yield writeChunk({ content: delta }, null);
        break;
      }
      case "response.reasoning.delta":
      case "response.reasoning_text.delta":
        for (const chunk of emitReasoning(reasoningKey("text", event.content_index), stringValue(event.delta))) {
          yield chunk;
        }
        break;
      case "response.reasoning_summary_text.delta":
        for (const chunk of emitReasoning(reasoningKey("summary", event.summary_index), stringValue(event.delta))) {
          yield chunk;
        }
        break;
      case "response.reasoning_text.done":
        for (const chunk of emitReasoning(reasoningKey("text", event.content_index), stringValue(event.text))) {
          yield chunk;
        }
        break;
      case "response.reasoning_summary_text.done":
        for (const chunk of emitReasoning(reasoningKey("summary", event.summary_index), stringValue(event.text))) {
          yield chunk;
        }
        break;
      case "response.reasoning_summary_part.done": {
        const part = (event.part ?? {}) as Json;
        let text = stringValue(part.text);
        if (!text) text = stringValue(event.text);
        for (const chunk of emitReasoning(reasoningKey("summary", event.summary_index), text)) {
          yield chunk;
        }
        break;
      }
      case "response.output_item.added": {
        const item = (event.item ?? {}) as Json;
        if (item.type === "function_call") {
          if (!sentRole) {
            yield writeChunk({ role: "assistant" }, null);
            sentRole = true;
          }
          const id = toChatCallId(defaultStringValue(item.call_id, stringValue(item.id)));
          yield writeChunk(
            {
              tool_calls: [
                {
                  index: toolIndex,
                  id,
                  type: "function",
                  function: { name: stringValue(item.name), arguments: "" },
                },
              ],
            },
            null
          );
        }
        break;
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const delta = stringValue(event.delta);
        if (delta) {
          yield writeChunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta } }] }, null);
        }
        break;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = (event.item ?? {}) as Json;
        if (type === "response.function_call_arguments.done" || item.type === "function_call") {
          toolIndex += 1;
        } else if (item.type === "reasoning") {
          const collected: string[] = [];
          reasoning.addItem(item, (key, text) => {
            collected.push(...emitReasoning(key, text));
          });
          for (const chunk of collected) yield chunk;
        }
        break;
      }
      case "response.completed":
      case "response.done": {
        const response = (event.response ?? event) as Json;
        const usage = responseUsageToChatUsage(response.usage);
        let finish = "stop";
        if (response.status === "incomplete") finish = "length";
        if (toolIndex > 0) finish = "tool_calls";
        yield writeChunk({}, finish, usage);
        break;
      }
      default:
        break;
    }
  }
  yield "data: [DONE]\n\n";
}

export function responsesSseToChatStream(
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  return toStream(transformResponsesSseToChat(source, model));
}
