import { defaultStringValue, numberFromAny, randomId, stringValue } from "#providers/lib/helpers.ts";
import { sseDataLines } from "#providers/lib/sse.ts";

type Json = Record<string, unknown>;

export function anthropicStopReasonToFinish(reason: string, hasToolCalls: boolean): string {
  switch (reason) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      break;
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

export function anthropicUsageToChatUsage(raw: unknown): Json {
  const usage = (raw ?? {}) as Json;
  const input = numberFromAny(usage.input_tokens);
  const output = numberFromAny(usage.output_tokens);
  const out: Json = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const cached = numberFromAny(usage.cache_read_input_tokens);
  const write = numberFromAny(usage.cache_creation_input_tokens);
  if (cached > 0 || write > 0) {
    out.prompt_tokens_details = { cached_tokens: cached, cache_write_tokens: write };
  }
  return out;
}

async function* transformAnthropicMessagesSseToChat(
  source: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<string> {
  let completionId = randomId("chatcmpl");
  let modelName = model;
  let sentRole = false;
  let toolIndex = -1;
  const toolIndexByBlock = new Map<number, number>();
  let finish = "stop";
  let usage: Json | null = null;

  const writeChunk = (delta: Json, finishReason: unknown): string => {
    const chunk: Json = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage && finishReason !== null && finishReason !== undefined) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };
  const ensureRole = (): string => {
    if (sentRole) return "";
    sentRole = true;
    return writeChunk({ role: "assistant", content: "" }, null);
  };

  for await (const data of sseDataLines(source)) {
    if (!data || data === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    switch (stringValue(event.type)) {
      case "message_start": {
        const message = event.message;
        if (message !== null && typeof message === "object") {
          const msg = message as Json;
          const id = stringValue(msg.id);
          if (id) completionId = id;
          const name = stringValue(msg.model);
          if (name) modelName = name;
        }
        break;
      }
      case "content_block_start": {
        const block = (event.content_block ?? {}) as Json;
        if (stringValue(block.type) !== "tool_use") break;
        const role = ensureRole();
        if (role) yield role;
        toolIndex += 1;
        toolIndexByBlock.set(numberFromAny(event.index), toolIndex);
        yield writeChunk(
          {
            tool_calls: [
              {
                index: toolIndex,
                id: defaultStringValue(stringValue(block.id), randomId("call")),
                type: "function",
                function: { name: stringValue(block.name), arguments: "" },
              },
            ],
          },
          null
        );
        break;
      }
      case "content_block_delta": {
        const delta = (event.delta ?? {}) as Json;
        switch (stringValue(delta.type)) {
          case "text_delta": {
            const text = stringValue(delta.text);
            if (text) {
              const role = ensureRole();
              if (role) yield role;
              yield writeChunk({ content: text }, null);
            }
            break;
          }
          case "thinking_delta": {
            const text = stringValue(delta.thinking);
            if (text) {
              const role = ensureRole();
              if (role) yield role;
              yield writeChunk({ reasoning_content: text }, null);
            }
            break;
          }
          case "input_json_delta": {
            const partial = stringValue(delta.partial_json);
            if (!partial) break;
            const blockIndex = numberFromAny(event.index);
            let index = toolIndexByBlock.get(blockIndex);
            if (index === undefined) {
              toolIndex += 1;
              index = toolIndex;
              toolIndexByBlock.set(blockIndex, index);
              const role = ensureRole();
              if (role) yield role;
              yield writeChunk(
                {
                  tool_calls: [
                    {
                      index,
                      id: randomId("call"),
                      type: "function",
                      function: { name: "", arguments: "" },
                    },
                  ],
                },
                null
              );
            }
            yield writeChunk({ tool_calls: [{ index, function: { arguments: partial } }] }, null);
            break;
          }
          default:
            break;
        }
        break;
      }
      case "message_delta": {
        const delta = event.delta;
        if (delta !== null && typeof delta === "object") {
          finish = anthropicStopReasonToFinish(stringValue((delta as Json).stop_reason), toolIndex >= 0);
        }
        if (event.usage !== undefined && event.usage !== null) {
          usage = anthropicUsageToChatUsage(event.usage);
        }
        break;
      }
      case "message_stop": {
        if (!sentRole) {
          yield writeChunk({ role: "assistant", content: "" }, finish);
          sentRole = true;
        } else {
          yield writeChunk({}, finish);
        }
        break;
      }
      default:
        break;
    }
  }
  if (!sentRole) yield writeChunk({ role: "assistant", content: "" }, finish);
  yield "data: [DONE]\n\n";
}

export function anthropicMessagesSseToChatStream(
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformAnthropicMessagesSseToChat(source, model)[Symbol.asyncIterator]();
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
      await iterator.return?.(undefined);
    },
  });
}
