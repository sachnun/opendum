import {
  cloneAnyMap,
  numberFromAny,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import { sseDataLines } from "#providers/lib/sse.ts";
import {
  RETIRED_MODEL_PATTERN,
  anySlice,
  type Json,
  randomHyphenId,
} from "#providers/providers/antigravity/config.ts";
import type { AntigravityProvider } from "#providers/providers/antigravity/provider.ts";
import type { ToolSchemaMap } from "#providers/providers/antigravity/schema.ts";

export {
  bestSchemaUnionOption,
  buildToolSchemaMap,
  cloneSchemaWithoutUnions,
  enumFromSchemaUnion,
  filteredSchemaRequired,
  flattenAntigravityClaudeUnion,
  geminiTools,
  inferAntigravityClaudeSchemaType,
  sanitizeAntigravityClaudeToolSchema,
  sanitizeGoogleFunctionSchema,
  sanitizeToolSchemaKeys,
  schemaTypeAllowsNull,
  schemaUnionOptionScore,
} from "#providers/providers/antigravity/schema.ts";
export type { ToolSchemaMap } from "#providers/providers/antigravity/schema.ts";

export function processEscapeSequencesOnly(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if ((!value.includes("\\n") && !value.includes("\\t")) || value.includes('\\"') || value.includes("\\\\")) {
    return value;
  }
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as unknown;
  } catch {
    return value;
  }
}

export function normalizeToolCallArgs(args: unknown, toolName: string, schemas: ToolSchemaMap): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const record = args as Json;
  const params = schemas[toolName] ?? {};
  const result: Json = {};
  for (const [key, value] of Object.entries(record)) {
    const expectedType = params[key]?.typ ?? "";
    if (expectedType === "string") {
      result[key] = processEscapeSequencesOnly(value);
      continue;
    }
    if (typeof value === "string" && (expectedType === "array" || expectedType === "object")) {
      try {
        result[key] = JSON.parse(value) as unknown;
      } catch {
        result[key] = processEscapeSequencesOnly(value);
      }
      continue;
    }
    result[key] = processEscapeSequencesOnly(value);
  }
  return result;
}

export function unwrapGeminiResponse(data: unknown): Json {
  if (Array.isArray(data)) {
    for (const item of data) {
      const unwrapped = unwrapGeminiResponse(item);
      if (Object.keys(unwrapped).length > 0) return unwrapped;
    }
    return {};
  }
  const obj = (data ?? {}) as Json;
  const response = obj.response;
  if (response !== null && typeof response === "object" && !Array.isArray(response)) return response as Json;
  return obj;
}

export function geminiRetiredModelResponse(response: Json): string | null {
  const candidates = anySlice(response.candidates);
  if (candidates.length !== 1) return null;
  const candidate = (candidates[0] ?? {}) as Json;
  const content = (candidate.content ?? {}) as Json;
  const parts = anySlice(content.parts);
  if (parts.length !== 1) return null;
  const text = stringValue((parts[0] as Json).text).trim();
  if (!text || !RETIRED_MODEL_PATTERN.test(text)) return null;
  return text;
}

export function wrapCodeAssistPayload(projectId: string, model: string, geminiPayload: Json): Json {
  return {
    project: projectId,
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: randomHyphenId("agent"),
    request: geminiPayload,
  };
}

export function retiredResponse(notice: string | null): Response {
  return new Response(JSON.stringify({ error: { code: 404, message: notice ?? "", status: "NOT_FOUND" } }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

export async function peekRetiredNotice(
  resp: Response
): Promise<{ retired: boolean; notice: string | null; body: ReadableStream<Uint8Array> | null }> {
  if (!resp.body) return { retired: false, notice: null, body: null };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const prefix: Uint8Array[] = [];
  let buffered = "";
  let sawData = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        prefix.push(value);
        buffered += decoder.decode(value, { stream: true });
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        sawData = true;
        const dataText = trimmed.slice("data:".length).trim();
        if (!dataText || dataText === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataText) as unknown;
        } catch {
          continue;
        }
        const notice = geminiRetiredModelResponse(unwrapGeminiResponse(parsed));
        if (notice) {
          await reader.cancel().catch(() => undefined);
          return { retired: true, notice, body: null };
        }
      }
      if (sawData) break;
    }
  } finally {
    reader.releaseLock();
  }
  const remaining = resp.body.getReader();
  let prefixIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefix.length) {
        controller.enqueue(prefix[prefixIndex]);
        prefixIndex += 1;
        return;
      }
      const { done, value } = await remaining.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await remaining.cancel(reason);
    },
  });
  return { retired: false, notice: null, body };
}

export function geminiDeltas(response: Json, schemas: ToolSchemaMap, toolIndex: { value: number }): Json[] {
  const deltas: Json[] = [];
  for (const rawCandidate of anySlice(response.candidates)) {
    const candidate = (rawCandidate ?? {}) as Json;
    const content = (candidate.content ?? {}) as Json;
    const parts = anySlice(content.parts);
    const localToolIndex = 0;
    for (const rawPart of parts) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined && part.functionCall !== null) {
        const fn = part.functionCall as Json;
        const name = stringValue(fn.name);
        const args = normalizeToolCallArgs(fn.args, name, schemas);
        let encodedArgs = JSON.stringify(args);
        if (!encodedArgs || encodedArgs === "null") encodedArgs = "{}";
        let id = stringValue(fn.id);
        if (!id) id = randomId("call");
        const idx = toolIndex.value;
        toolIndex.value += 1;
        void localToolIndex;
        deltas.push({
          tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: encodedArgs } }],
        });
        continue;
      }
      const text = stringValue(part.text);
      if (!text) continue;
      if (part.thought === true) deltas.push({ reasoning_content: text });
      else deltas.push({ content: text });
    }
  }
  return deltas;
}

export function stripToolCallIndexes(calls: unknown[]): unknown[] {
  return calls.map((rawCall) => {
    if (rawCall === null || typeof rawCall !== "object" || Array.isArray(rawCall)) return rawCall;
    const copyCall = cloneAnyMap(rawCall as Json);
    delete copyCall.index;
    return copyCall;
  });
}

export function geminiUsage(response: Json): Json | null {
  const rawUsage = response.usageMetadata;
  if (rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return null;
  const usage = rawUsage as Json;
  const out: Json = {
    prompt_tokens: numberFromAny(usage.promptTokenCount),
    completion_tokens: numberFromAny(usage.candidatesTokenCount),
    total_tokens: numberFromAny(usage.totalTokenCount),
  };
  const cachedTokens = numberFromAny(usage.cachedContentTokenCount);
  if (cachedTokens > 0) out.prompt_tokens_details = { cached_tokens: cachedTokens };
  const thoughtsTokens = numberFromAny(usage.thoughtsTokenCount);
  if (thoughtsTokens > 0) out.completion_tokens_details = { reasoning_tokens: thoughtsTokens };
  return out;
}

export function geminiFinishReason(response: Json, hasToolCalls: boolean): string | null {
  for (const rawCandidate of anySlice(response.candidates)) {
    const candidate = (rawCandidate ?? {}) as Json;
    const finish = stringValue(candidate.finishReason);
    if (!finish) continue;
    if (hasToolCalls) return "tool_calls";
    switch (finish) {
      case "MAX_TOKENS":
        return "length";
      case "TOOL_CALLS":
        return "tool_calls";
      default:
        return "stop";
    }
  }
  return null;
}

export function geminiToOpenAiCompletion(response: Json, model: string, schemas: ToolSchemaMap): Json {
  let content = "";
  let reasoning = "";
  let toolCalls: unknown[] = [];
  const toolIndex = { value: 0 };
  for (const delta of geminiDeltas(response, schemas, toolIndex)) {
    content += stringValue(delta.content);
    reasoning += stringValue(delta.reasoning_content);
    if (Array.isArray(delta.tool_calls)) toolCalls = [...toolCalls, ...delta.tool_calls];
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  let finish = "stop";
  if (toolCalls.length > 0) {
    message.tool_calls = stripToolCallIndexes(toolCalls);
    finish = "tool_calls";
  } else {
    const mapped = geminiFinishReason(response, false);
    if (mapped) finish = mapped;
  }
  const usage = geminiUsage(response) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

async function* transformGeminiSse(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): AsyncGenerator<string> {
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  const toolIndex = { value: 0 };
  let hasToolCalls = false;
  let sentFinal = false;
  let trackedUsage: Json | null = null;
  const pending: string[] = [];

  const writeChunk = (delta: Json, finish: unknown, usage: Json | null): void => {
    const chunk: Json = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) chunk.usage = usage;
    pending.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const handleData = async (dataText: string): Promise<void> => {
    if (!dataText || dataText === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText) as unknown;
    } catch {
      return;
    }
    const response = unwrapGeminiResponse(parsed);
    await provider.cacheSignaturesFromResponse(response, model, sessionId);
    const notice = geminiRetiredModelResponse(response);
    if (notice) {
      writeChunk({ content: notice }, "stop", null);
      sentFinal = true;
      return;
    }
    const usage = geminiUsage(response);
    if (usage) trackedUsage = usage;
    for (const delta of geminiDeltas(response, schemas, toolIndex)) {
      if (!sentRole) {
        writeChunk({ role: "assistant", content: "" }, null, null);
        sentRole = true;
      }
      if (delta.tool_calls !== undefined) hasToolCalls = true;
      writeChunk(delta, null, null);
    }
    const finish = geminiFinishReason(response, hasToolCalls);
    if (finish) {
      writeChunk({}, finish, null);
      sentFinal = true;
    }
  };

  for await (const data of sseDataLines(source)) {
    await handleData(data);
    for (const chunk of pending.splice(0)) yield chunk;
  }

  if (trackedUsage) writeChunk({}, null, trackedUsage);
  if (!sentFinal) writeChunk({}, hasToolCalls ? "tool_calls" : "stop", null);
  pending.push("data: [DONE]\n\n");
  for (const chunk of pending.splice(0)) yield chunk;
}

export function geminiSseToOpenAiStream(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformGeminiSse(provider, source, model, sessionId, schemas)[Symbol.asyncIterator]();
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

export async function geminiStreamToOpenAiCompletionImpl(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): Promise<Json> {
  let content = "";
  let reasoning = "";
  let toolCalls: unknown[] = [];
  let usage: Json | null = null;
  let finish = "stop";
  const toolIndex = { value: 0 };
  const handleData = async (dataText: string): Promise<boolean> => {
    if (!dataText || dataText === "[DONE]") return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText) as unknown;
    } catch {
      return false;
    }
    const response = unwrapGeminiResponse(parsed);
    await provider.cacheSignaturesFromResponse(response, model, sessionId);
    const notice = geminiRetiredModelResponse(response);
    if (notice) throw new Error(`antigravity model ${model} is retired: ${notice}`);
    for (const delta of geminiDeltas(response, schemas, toolIndex)) {
      content += stringValue(delta.content);
      reasoning += stringValue(delta.reasoning_content);
      if (Array.isArray(delta.tool_calls)) toolCalls = [...toolCalls, ...delta.tool_calls];
    }
    const nextUsage = geminiUsage(response);
    if (nextUsage) usage = nextUsage;
    const mapped = geminiFinishReason(response, toolCalls.length > 0);
    if (mapped) finish = mapped;
    return false;
  };
  for await (const data of sseDataLines(source)) {
    if (await handleData(data)) break;
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = stripToolCallIndexes(toolCalls);
    finish = "tool_calls";
  }
  const finalUsage = usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: finalUsage,
  };
}
