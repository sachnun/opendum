import { randomId, stringValue } from "#providers/lib/helpers.ts";
import { sseDataLines } from "#providers/lib/sse.ts";
import { type Json } from "#providers/providers/antigravity/config.ts";
import type { AntigravityProvider } from "#providers/providers/antigravity/provider.ts";
import type { ToolSchemaMap } from "#providers/providers/antigravity/schema.ts";
import {
  geminiDeltas,
  geminiFinishReason,
  geminiRetiredModelResponse,
  geminiUsage,
  stripToolCallIndexes,
  unwrapGeminiResponse,
} from "#providers/providers/antigravity/transform.ts";

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
