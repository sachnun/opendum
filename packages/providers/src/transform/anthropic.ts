import {
  contentToText,
  defaultStringValue,
  isTruthful,
  numberFromAny,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import { convertImageURLsToBase64, type ImageFetch } from "#providers/lib/images.ts";
import { anthropicStopReasonToFinish, anthropicUsageToChatUsage } from "#providers/transform/anthropic-stream.ts";

export { anthropicMessagesSseToChatStream, anthropicUsageToChatUsage } from "#providers/transform/anthropic-stream.ts";

type Json = Record<string, unknown>;

const DEFAULT_MAX_TOKENS = 4096;

export async function buildAnthropicMessagesPayload(
  body: Json,
  modelName: string,
  stream: boolean,
  imageFetch?: ImageFetch
): Promise<Json> {
  const messagesInput = Array.isArray(body.messages) ? body.messages : [];
  const messages = imageFetch
    ? await convertImageURLsToBase64(imageFetch, messagesInput)
    : messagesInput;
  const payload: Json = {
    model: modelName,
    stream,
    max_tokens: anthropicMaxTokens(body),
  };
  const { system, messages: converted } = anthropicMessagesFromChat(messages);
  if (system) payload.system = system;
  payload.messages = converted;
  if (body.temperature !== undefined && body.temperature !== null) payload.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) payload.top_p = body.top_p;
  const stop = anthropicStopSequences(body.stop);
  if (stop.length > 0) payload.stop_sequences = stop;
  const tools = anthropicToolsFromChat(body.tools);
  if (tools.length > 0) {
    payload.tools = tools;
    const choice = anthropicToolChoiceFromChat(body.tool_choice);
    if (choice) payload.tool_choice = choice;
  }
  applyAnthropicThinking(payload, body);
  return payload;
}

function anthropicMaxTokens(body: Json): number {
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
    const value = numberFromAny(body[key]);
    if (value > 0) return value;
  }
  return DEFAULT_MAX_TOKENS;
}

function anthropicStopSequences(value: unknown): unknown[] {
  if (typeof value === "string") return value ? [value] : [];
  if (Array.isArray(value)) return value;
  return [];
}

function anthropicMessagesFromChat(messages: unknown[]): { system: string; messages: unknown[] } {
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
    switch (stringValue(msg.role)) {
      case "system":
      case "developer": {
        flush();
        const text = contentToText(msg.content);
        if (text) system.push(text);
        break;
      }
      case "user": {
        flush();
        const blocks = anthropicContentBlocks(msg.content);
        if (blocks.length > 0) out.push({ role: "user", content: blocks });
        break;
      }
      case "assistant": {
        flush();
        const blocks = anthropicAssistantBlocks(msg);
        if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool":
        toolResults.push({
          type: "tool_result",
          tool_use_id: stringValue(msg.tool_call_id),
          content: anthropicToolResultContent(msg.content),
        });
        break;
      default:
        break;
    }
  }
  flush();
  return { system: system.join("\n\n"), messages: out };
}

function anthropicContentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    const text = contentToText(content);
    return text ? [{ type: "text", text }] : [];
  }
  const blocks: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    switch (stringValue(part.type)) {
      case "text":
      case "input_text":
      case "output_text": {
        const text = stringValue(part.text);
        if (text) blocks.push({ type: "text", text });
        break;
      }
      case "image_url": {
        const block = anthropicImageBlock(part.image_url);
        if (block) blocks.push(block);
        break;
      }
      case "image": {
        const block = anthropicImageBlock(part.source);
        if (block) blocks.push(block);
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

function anthropicAssistantBlocks(msg: Json): unknown[] {
  const blocks: unknown[] = [];
  const text = contentToText(msg.content);
  if (text) blocks.push({ type: "text", text });
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const raw of calls) {
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    let input: unknown = {};
    const args = stringValue(fn.arguments);
    if (args) {
      try {
        input = JSON.parse(args);
      } catch {
        input = {};
      }
    }
    blocks.push({
      type: "tool_use",
      id: defaultStringValue(stringValue(call.id), randomId("toolu")),
      name,
      input,
    });
  }
  return blocks;
}

function anthropicImageBlock(value: unknown): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Json;
  if (stringValue(source.type) === "base64" && stringValue(source.data)) {
    return { type: "image", source };
  }
  const url = stringValue(source.url);
  if (!url) return null;
  const parsed = parseDataUri(url);
  if (parsed) {
    return {
      type: "image",
      source: { type: "base64", media_type: parsed.mediaType, data: parsed.data },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function parseDataUri(value: string): { mediaType: string; data: string } | null {
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

function anthropicToolResultContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  const text = contentToText(content);
  if (text) return text;
  return "";
}

function anthropicToolsFromChat(raw: unknown): unknown[] {
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
    const converted: Json = { name, input_schema: params };
    const description = stringValue(fn.description);
    if (description) converted.description = description;
    out.push(converted);
  }
  return out;
}

function anthropicToolChoiceFromChat(raw: unknown): Json | null {
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
    let name = stringValue(typed.name);
    const fn = typed.function;
    if (fn !== null && typeof fn === "object" && !Array.isArray(fn)) {
      name = stringValue((fn as Json).name);
    }
    if (name) return { type: "tool", name };
    switch (stringValue(typed.type)) {
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

function applyAnthropicThinking(payload: Json, body: Json): void {
  let budget = numberFromAny(body.thinking_budget);
  if (budget === 0) budget = anthropicEffortBudget(body);
  if (budget <= 0) return;
  const maxTokens = numberFromAny(payload.max_tokens);
  if (maxTokens <= budget) payload.max_tokens = budget + 1024;
  payload.thinking = { type: "enabled", budget_tokens: budget };
}

function anthropicEffortBudget(body: Json): number {
  if (!isTruthful(body._includeReasoning)) return 0;
  let effort = stringValue(body.reasoning_effort).toLowerCase();
  const reasoning = body.reasoning;
  if (!effort && reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    effort = stringValue((reasoning as Json).effort).toLowerCase();
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

export function anthropicMessagesToChatCompletion(data: Json, model: string): Json {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  const blocks = Array.isArray(data.content) ? data.content : [];
  for (const raw of blocks) {
    const block = (raw ?? {}) as Json;
    switch (stringValue(block.type)) {
      case "text":
        content += stringValue(block.text);
        break;
      case "thinking":
        reasoning += stringValue(block.thinking);
        break;
      case "tool_use": {
        let args = "{}";
        if (block.input !== undefined && block.input !== null) {
          args = JSON.stringify(block.input);
        }
        toolCalls.push({
          id: defaultStringValue(stringValue(block.id), randomId("call")),
          type: "function",
          function: { name: stringValue(block.name), arguments: args },
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
  const finish = anthropicStopReasonToFinish(stringValue(data.stop_reason), toolCalls.length > 0);
  return {
    id: defaultStringValue(stringValue(data.id), randomId("chatcmpl")),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: defaultStringValue(model, stringValue(data.model)),
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: anthropicUsageToChatUsage(data.usage),
  };
}
