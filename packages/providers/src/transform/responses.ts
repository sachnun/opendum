import {
  cloneAnyMap,
  contentToText,
  defaultEmpty,
  defaultStringValue,
  jsonResponse,
  normalizeToolChoice,
  numberFromAny,
  randomId,
  stringSlice,
  stringValue,
  sseResponse,
  uniqueStrings,
} from "#providers/lib/helpers.ts";
import { convertResponsesInputImageURLsToBase64 } from "#providers/lib/images.ts";
import {
  responsesFunctionCallItem,
  responsesMessageItem,
  responsesReasoningItem,
  responsesUsageFromChat,
  toResponsesApiId,
} from "#providers/transform/responses-core.ts";
import { chatSseToResponsesStream } from "#providers/transform/responses-state.ts";

export {
  responsesFunctionCallItem,
  responsesMessageItem,
  responsesReasoningItem,
  responsesUsageFromChat,
  toChatCallId,
  toResponsesApiId,
} from "#providers/transform/responses-core.ts";
export {
  responsesJsonToChatCompletion,
  responsesSseToChatStream,
  responseUsageToChatUsage,
} from "#providers/transform/responses-stream.ts";
export { chatSseToResponsesStream } from "#providers/transform/responses-state.ts";

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

export function chatCompletionToResponsesJson(data: Json, model: string): Json {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  let message: Json = {};
  let finishReason = "stop";
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Json;
    const msg = choice.message;
    if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) message = msg as Json;
    const fr = stringValue(choice.finish_reason);
    if (fr) finishReason = fr;
  }
  const output: unknown[] = [];
  const content = stringValue(message.content);
  const reasoning = stringValue(message.reasoning_content);
  if (reasoning) output.push(responsesReasoningItem(reasoning));
  if (content) output.push(responsesMessageItem(content));
  const tcs = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of tcs) {
    const tc = (raw ?? {}) as Json;
    const fn = (tc.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    const id = toResponsesApiId(stringValue(tc.id));
    output.push(responsesFunctionCallItem(id, name, defaultStringValue(fn.arguments, "{}")));
  }
  const usage = (data.usage ?? {}) as Json;
  let status = "completed";
  let incompleteDetails: Json | null = null;
  if (finishReason === "length") {
    status = "incomplete";
    incompleteDetails = { reason: "max_output_tokens" };
  }
  const response: Json = {
    id: randomId("resp"),
    object: "response",
    model,
    output,
    status,
    usage: responsesUsageFromChat(usage),
  };
  if (incompleteDetails) response.incomplete_details = incompleteDetails;
  return response;
}

export async function responsesSseToResponsesJson(source: ReadableStream<Uint8Array>): Promise<Json> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;
  let result: Json | null = null;
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("data:")) continue;
    const data = text.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const type = stringValue(event.type);
    if (
      type === "response.completed" ||
      type === "response.incomplete" ||
      type === "response.failed"
    ) {
      const response = event.response;
      if (response !== null && typeof response === "object") result = response as Json;
    }
  }
  if (!result) throw new Error("responses stream ended without a terminal event");
  return result;
}

export async function chatSseToChatCompletion(
  source: ReadableStream<Uint8Array>,
  model: string
): Promise<Json> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Json;

  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage: Json | null = null;
  const tools: Array<{ id: string; name: string; args: string }> = [];
  const byIndex = new Map<number, { id: string; name: string; args: string }>();

  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("data:")) continue;
    const data = text.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const usageValue = chunk.usage;
    if (usageValue !== null && typeof usageValue === "object" && Object.keys(usageValue as Json).length > 0) {
      usage = usageValue as Json;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue;
    const choice = (choices[0] ?? {}) as Json;
    if (!choice) continue;
    const delta = choice.delta;
    if (delta !== null && typeof delta === "object") {
      const d = delta as Json;
      content += stringValue(d.content);
      reasoning += stringValue(d.reasoning_content);
      const calls = Array.isArray(d.tool_calls) ? d.tool_calls : [];
      for (const rawCall of calls) {
        const call = (rawCall ?? {}) as Json;
        const fn = (call.function ?? {}) as Json;
        const index = numberFromAny(call.index);
        let tool = byIndex.get(index);
        if (!tool) {
          tool = { id: stringValue(call.id), name: stringValue(fn.name), args: "" };
          byIndex.set(index, tool);
          tools.push(tool);
        }
        if (!tool.id) tool.id = stringValue(call.id);
        if (!tool.name) tool.name = stringValue(fn.name);
        tool.args += stringValue(fn.arguments);
      }
    }
    const finish = stringValue(choice.finish_reason);
    if (finish) finishReason = finish;
  }

  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.length > 0) {
    message.tool_calls = tools.map((tool) => ({
      id: tool.id,
      type: "function",
      function: { name: tool.name, arguments: tool.args.trim() || "{}" },
    }));
    if (finishReason === "stop") finishReason = "tool_calls";
  }
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export async function adaptChatResponseToResponses(
  resp: Response,
  model: string,
  stream: boolean
): Promise<Response> {
  if (!resp.body) {
    throw new Error("upstream response has no body");
  }
  if (stream) {
    return sseResponse(chatSseToResponsesStream(resp.body, model));
  }
  const data = (await resp.json()) as Json;
  return jsonResponse(200, chatCompletionToResponsesJson(data, model));
}

export interface ResponsesNativeProvider {
  responsesNative(model: string): boolean;
}

export async function adaptForResponsesClient(
  provider: { responsesNative?(model: string): boolean },
  resp: Response,
  payload: Json,
  stream: boolean
): Promise<Response> {
  if (!Array.isArray(payload._responsesInput)) return resp;
  const model = stringValue(payload.model);
  if (typeof provider.responsesNative === "function" && provider.responsesNative(model)) {
    return resp;
  }
  return adaptChatResponseToResponses(resp, model, stream);
}

export function clampPromptCacheKey(key: string): string {
  const chars = [...key];
  if (chars.length > 64) return chars.slice(0, 64).join("");
  return key;
}

export async function buildResponsesApiPayload(
  body: Json,
  modelName: string,
  stream: boolean,
  imageFetch?: (url: string, init?: RequestInit) => Promise<Response>
): Promise<Json> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload: Json = { model: modelName, stream };
  if (Array.isArray(body._responsesInput)) {
    payload.input = normalizeResponsesInput(body._responsesInput);
  } else {
    payload.input = messagesToResponsesInput(messages);
  }
  const finishPayload = (input: unknown[]): Json => {
    payload.input = input;
    const instructions = stringValue(body.instructions);
    if (instructions) payload.instructions = instructions;
    if (body.temperature !== undefined && body.temperature !== null) payload.temperature = body.temperature;
    if (body.top_p !== undefined && body.top_p !== null) payload.top_p = body.top_p;
    if (body.max_tokens !== undefined && body.max_tokens !== null) {
      payload.max_output_tokens = body.max_tokens;
    } else if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== null) {
      payload.max_output_tokens = body.max_completion_tokens;
    } else if (body.max_output_tokens !== undefined && body.max_output_tokens !== null) {
      payload.max_output_tokens = body.max_output_tokens;
    }
    const tools = convertToolsForResponses(body.tools);
    if (tools.length > 0) payload.tools = tools;
    if (body.tool_choice !== undefined && body.tool_choice !== null) {
      payload.tool_choice = normalizeToolChoice(body.tool_choice);
    }
    if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
      payload.parallel_tool_calls = body.parallel_tool_calls;
    }
    if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
      payload.reasoning = cloneAnyMap(body.reasoning as Json);
    } else {
      const effort = stringValue(body.reasoning_effort);
      if (effort) payload.reasoning = { effort };
    }
    const reasoning = payload.reasoning;
    if (
      reasoning !== null &&
      typeof reasoning === "object" &&
      !Array.isArray(reasoning) &&
      body._includeReasoning === true &&
      (reasoning as Json).summary === undefined
    ) {
      (reasoning as Json).summary = "auto";
    }
    const include = stringSlice(body.include);
    if (body._includeReasoning === true) include.push("reasoning.encrypted_content");
    if (include.length > 0) payload.include = uniqueStrings(include);
    for (const key of [
      "previous_response_id",
      "prompt_cache_key",
      "service_tier",
      "store",
      "text",
      "truncation",
      "user",
    ]) {
      if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
    }
    if (payload.prompt_cache_key === undefined || payload.prompt_cache_key === null) {
      const sessionId = stringValue(body._sessionId);
      if (sessionId) payload.prompt_cache_key = clampPromptCacheKey(sessionId);
    }
    return payload;
  };

  const input = payload.input as unknown[];
  const converted = imageFetch ? await convertResponsesInputImageURLsToBase64(imageFetch, input) : input;
  return finishPayload(converted);
}
