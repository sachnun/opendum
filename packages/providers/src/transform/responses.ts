import {
  cloneAnyMap,
  defaultStringValue,
  jsonResponse,
  normalizeToolChoice,
  randomId,
  sseResponse,
  stringSlice,
  stringValue,
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
import {
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesInput,
} from "#providers/transform/responses-input.ts";

export {
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesContent,
  normalizeResponsesInput,
} from "#providers/transform/responses-input.ts";
export {
  chatSseToChatCompletion,
  responsesSseToResponsesJson,
} from "#providers/transform/responses-collect.ts";

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
