import { Value, Payload, Ids, JSONText } from "@opendum/providers/helpers";
import { Effect } from "effect";
import { ChatImageInliner, type ImageFetch } from "@opendum/providers/images";

type Json = Record<string, unknown>;

const DEFAULT_MAX_TOKENS = 4096;

export async function payloadFor(
  body: Json,
  modelName: string,
  stream: boolean,
  imageFetch?: ImageFetch
): Promise<Json> {
  const messagesInput = Array.isArray(body.messages) ? body.messages : [];
  const messages = imageFetch
    ? await Effect.runPromise(new ChatImageInliner(imageFetch).run(messagesInput))
    : messagesInput;
  const payload: Json = {
    model: modelName,
    stream,
    max_tokens: maxTokens(body),
  };
  const { system, messages: converted } = fromChat(messages);
  if (system) payload.system = system;
  payload.messages = converted;
  if (body.temperature !== undefined && body.temperature !== null) payload.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) payload.top_p = body.top_p;
  const stop = stopSequences(body.stop);
  if (stop.length > 0) payload.stop_sequences = stop;
  const tools = toolsOf(body.tools);
  if (tools.length > 0) {
    payload.tools = tools;
    const choice = choiceOf(body.tool_choice);
    if (choice) payload.tool_choice = choice;
  }
  applyThinking(payload, body);
  return payload;
}

function maxTokens(body: Json): number {
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const value = Value.number(body[key]);
    if (value > 0) return value;
  }
  return DEFAULT_MAX_TOKENS;
}

function stopSequences(value: unknown): unknown[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value;
  return [];
}

function fromChat(messages: unknown[]): { system: string; messages: unknown[] } {
  const system: string[] = [];
  const out: unknown[] = [];
  let toolResults: unknown[] = [];
  const flush = (): void => {
    if (toolResults.length > 0) {
      out.push({ role: "user", content: toolResults });
      toolResults = [];
    }
  };
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    switch (Value.string(msg.role)) {
      case "system":
      case "developer": {
        flush();
        const text = Payload.text(msg.content);
        if (text) system.push(text);
        break;
      }
      case "user": {
        flush();
        const blocks = blocksOf(msg.content);
        if (blocks.length > 0) out.push({ role: "user", content: blocks });
        break;
      }
      case "assistant": {
        flush();
        const blocks = assistantParts(msg);
        if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool":
        toolResults.push({
          type: "tool_result",
          tool_use_id: Value.string(msg.tool_call_id),
          content: resultContent(msg.content),
        });
        break;
      default:
        break;
    }
  }
  flush();
  return { system: system.join("\n\n"), messages: out };
}

function blocksOf(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    const text = Payload.text(content);
    return text ? [{ type: "text", text }] : [];
  }
  const blocks: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    switch (Value.string(part.type)) {
      case "text":
      case "input_text":
      case "output_text": {
        const text = Value.string(part.text);
        if (text) blocks.push({ type: "text", text });
        break;
      }
      case "image_url": {
        const block = imageOf(part.image_url);
        if (block) blocks.push(block);
        break;
      }
      case "image": {
        const block = imageOf(part.source);
        if (block) blocks.push(block);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function assistantParts(msg: Json): unknown[] {
  const blocks: unknown[] = [];
  const text = Payload.text(msg.content);
  if (text) blocks.push({ type: "text", text });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const raw of calls) {
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    const name = Value.string(fn.name);
    if (!name) continue;
    const args = Value.string(fn.arguments);
    const input: unknown = args ? (JSONText.record(args) ?? {}) : {};
    blocks.push({
      type: "tool_use",
      id: Value.stringOr(Value.string(call.id), Ids.random("toolu")),
      name,
      input,
    });
  }
  return blocks;
}

function imageOf(value: unknown): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Json;
  if (Value.string(source.type) === "base64" && Value.string(source.data)) {
    return { type: "image", source };
  }
  const url = Value.string(source.url);
  if (!url) return null;
  const parsed = dataUri(url);
  if (parsed) {
    return {
      type: "image",
      source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function dataUri(value: string): { mediaType: string; data: string } | null {
  if (!value.startsWith("data:")) return null;
  const trimmed = value.slice("data:".length);
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const header = trimmed.slice(0, comma);
  const data = trimmed.slice(comma + 1);
  if (!data) return null;
  const mediaType = header.endsWith(";base64") ? header.slice(0, -";base64".length) : header;
  return { mediaType: mediaType || "image/png", data };
}

function resultContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  const text = Payload.text(content);
  if (text) return text;
  return "";
}

function toolsOf(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Json;
    let fn = (tool.function ?? {}) as Json;
    let name = Value.string(fn.name);
    if (!name) {
      name = Value.string(tool.name);
      fn = tool;
    }
    if (!name) continue;
    const params =
      fn.parameters !== null && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
        ? fn.parameters
        : { type: "object", properties: {} };
    const converted: Json = { name, input_schema: params };
    const description = Value.string(fn.description);
    if (description) converted.description = description;
    out.push(converted);
  }
  return out;
}

function choiceOf(raw: unknown): Json | null {
  if (typeof raw === "string") {
    switch (raw) {
      case "auto":
        return { type: "auto" };
      case "required":
      case "any":
        return { type: "any" };
      case "none":
        return { type: "none" };
      default:
        return null;
    }
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const typed = raw as Json;
    let name = Value.string(typed.name);
    const fn = typed.function;
    if (fn !== null && typeof fn === "object" && !Array.isArray(fn)) {
      name = Value.string((fn as Json).name);
    }
    if (name) return { type: "tool", name };
    switch (Value.string(typed.type)) {
      case "auto":
        return { type: "auto" };
      case "required":
      case "any":
        return { type: "any" };
      case "none":
        return { type: "none" };
      default:
        return null;
    }
  }
  return null;
}

function applyThinking(payload: Json, body: Json): void {
  let budget = Value.number(body.thinking_budget);
  if (budget === 0) budget = budgetFor(body);
  if (budget <= 0) return;
  const maxTokens = Value.number(payload.max_tokens);
  if (maxTokens <= budget) payload.max_tokens = budget + 1024;
  payload.thinking = { type: "enabled", budget_tokens: budget };
}

function budgetFor(body: Json): number {
  if (!Value.bool(body._includeReasoning)) return 0;
  let effort = Value.string(body.reasoning_effort).toLowerCase();
  const reasoning = body.reasoning;
  if (!effort && reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    effort = Value.string((reasoning as Json).effort).toLowerCase();
  }
  switch (effort) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
    default:
      return 0;
  }
}

export function fromMessages(data: Json, model: string): Json {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  const blocks = Array.isArray(data.content) ? data.content : [];
  for (const raw of blocks) {
    const block = (raw ?? {}) as Json;
    switch (Value.string(block.type)) {
      case "text":
        content += Value.string(block.text);
        break;
      case "thinking":
        reasoning += Value.string(block.thinking);
        break;
      case "tool_use": {
        let args = "{}";
        if (block.input !== undefined && block.input !== null) {
          args = JSON.stringify(block.input);
        }
        toolCalls.push({
          id: Value.stringOr(Value.string(block.id), Ids.random("call")),
          type: "function",
          function: { name: Value.string(block.name), arguments: args },
        });
        break;
      }
      default:
        break;
    }
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish = finishOf(Value.string(data.stop_reason), toolCalls.length > 0);
  return {
    id: Value.stringOr(Value.string(data.id), Ids.random("chatcmpl")),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: Value.stringOr(model, Value.string(data.model)),
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: anthropicUsage(data.usage),
  };
}

function finishOf(reason: string, hasToolCalls: boolean): string {
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

export function anthropicUsage(raw: unknown): Json {
  const usage = (raw ?? {}) as Json;
  const input = Value.number(usage.input_tokens);
  const output = Value.number(usage.output_tokens);
  const out: Json = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const cached = Value.number(usage.cache_read_input_tokens);
  const write = Value.number(usage.cache_creation_input_tokens);
  if (cached > 0 || write > 0) {
    out.prompt_tokens_details = { cached_tokens: cached, cache_write_tokens: write };
  }
  return out;
}

async function* dataLines(source: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      yield trimmed.slice("data:".length).trim();
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    yield trimmed.slice("data:".length).trim();
  }
  reader.releaseLock();
}

async function* chatStream(
  source: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<string> {
  let completionId = Ids.random("chatcmpl");
  let modelName = model;
  let sentRole = false;
  let toolIndex = -1;
  const indexByBlock = new Map<number, number>();
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

  for await (const data of dataLines(source)) {
    if (!data || data === "[DONE]") continue;
    const event = JSONText.record(data);
    if (!event) continue;
    switch (Value.string(event.type)) {
      case "message_start": {
        const message = event.message;
        if (message !== null && typeof message === "object") {
          const msg = message as Json;
          const id = Value.string(msg.id);
          if (id) completionId = id;
          const name = Value.string(msg.model);
          if (name) modelName = name;
        }
        break;
      }
      case "content_block_start": {
        const block = (event.content_block ?? {}) as Json;
        if (Value.string(block.type) !== "tool_use") break;
        const role = ensureRole();
        if (role) yield role;
        toolIndex += 1;
        indexByBlock.set(Value.number(event.index), toolIndex);
        yield writeChunk(
          {
            tool_calls: [
              {
                index: toolIndex,
                id: Value.stringOr(Value.string(block.id), Ids.random("call")),
                type: "function",
                function: { name: Value.string(block.name), arguments: "" },
              },
            ],
          },
          null
        );
        break;
      }
      case "content_block_delta": {
        const delta = (event.delta ?? {}) as Json;
        switch (Value.string(delta.type)) {
          case "text_delta": {
            const text = Value.string(delta.text);
            if (text) {
              const role = ensureRole();
              if (role) yield role;
              yield writeChunk({ content: text }, null);
            }
            break;
          }
          case "thinking_delta": {
            const text = Value.string(delta.thinking);
            if (text) {
              const role = ensureRole();
              if (role) yield role;
              yield writeChunk({ reasoning_content: text }, null);
            }
            break;
          }
          case "input_json_delta": {
            const partial = Value.string(delta.partial_json);
            if (!partial) break;
            const blockIndex = Value.number(event.index);
            let index = indexByBlock.get(blockIndex);
            if (index === undefined) {
              toolIndex += 1;
              index = toolIndex;
              indexByBlock.set(blockIndex, index);
              const role = ensureRole();
              if (role) yield role;
              yield writeChunk(
                {
                  tool_calls: [
                    {
                      index,
                      id: Ids.random("call"),
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
          finish = finishOf(Value.string((delta as Json).stop_reason), toolIndex >= 0);
        }
        if (event.usage !== undefined && event.usage !== null) {
          usage = anthropicUsage(event.usage);
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

export function messagesStream(
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = chatStream(source, model)[Symbol.asyncIterator]();
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
