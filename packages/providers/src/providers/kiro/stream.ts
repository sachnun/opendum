import { randomId, stringValue } from "#providers/lib/helpers.ts";
import {
  KiroParserState,
  KiroThinkingSplitter,
  kiroErrorMessage,
  kiroNumberAsFloat,
  kiroReasoningContent,
  kiroUsage,
  kiroUsageFromContext,
  parseKiroBracketToolCalls,
  parseKiroJsonEvents,
  type Json,
} from "#providers/providers/kiro/transform.ts";

async function* transformKiroSse(
  source: ReadableStream<Uint8Array>,
  model: string,
  parseThinking: boolean
): AsyncGenerator<string> {
  const state = new KiroParserState();
  const splitter = new KiroThinkingSplitter(parseThinking);
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  let toolCallCount = 0;
  let activeToolId = "";
  const toolIndex = new Map<string, number>();
  let hasNativeReasoning = false;
  let totalContent = "";
  let outputText = "";
  let contextUsagePercentage = 0;
  let explicitUsage: Json | null = null;
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
  const ensureRole = (): void => {
    if (sentRole) return;
    writeChunk({ role: "assistant", content: "" }, null, null);
    sentRole = true;
  };
  const emitContent = (contentDelta: string, reasoningDelta: string): void => {
    if (reasoningDelta) {
      ensureRole();
      outputText += reasoningDelta;
      writeChunk({ reasoning_content: reasoningDelta }, null, null);
    }
    if (contentDelta) {
      ensureRole();
      outputText += contentDelta;
      writeChunk({ content: contentDelta }, null, null);
    }
  };

  const processEvent = (event: Json): void => {
    if (event.contextUsagePercentage !== undefined) {
      contextUsagePercentage = kiroNumberAsFloat(event.contextUsagePercentage);
      return;
    }
    const usage = kiroUsage(event);
    if (usage) {
      explicitUsage = usage;
      return;
    }
    if (kiroErrorMessage(event)) return;
    const reasoning = kiroReasoningContent(event);
    if (reasoning) {
      hasNativeReasoning = true;
      emitContent("", reasoning);
      return;
    }
    if (typeof event.content === "string" && event.followupPrompt === undefined) {
      totalContent += event.content;
      const [contentDelta, reasoningDeltaValue] = splitter.process(event.content, false);
      let reasoningDelta = reasoningDeltaValue;
      if (hasNativeReasoning && reasoningDelta) reasoningDelta = "";
      emitContent(contentDelta, reasoningDelta);
    }
    const name = stringValue(event.name);
    if (name && stringValue(event.toolUseId)) {
      ensureRole();
      const id = stringValue(event.toolUseId);
      let idx = toolIndex.get(id);
      if (idx === undefined) {
        idx = toolCallCount;
        toolIndex.set(id, idx);
        toolCallCount += 1;
      }
      activeToolId = id;
      writeChunk(
        { tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: "" } }] },
        null,
        null
      );
      const input = stringValue(event.input);
      if (input) {
        writeChunk({ tool_calls: [{ index: idx, function: { arguments: input } }] }, null, null);
      }
    }
    const input = stringValue(event.input);
    if (input && !stringValue(event.name) && activeToolId) {
      const idx = toolIndex.get(activeToolId);
      if (idx !== undefined) {
        ensureRole();
        writeChunk({ tool_calls: [{ index: idx, function: { arguments: input } }] }, null, null);
      }
    }
    if (event.stop === true) activeToolId = "";
  };

  const reader = source.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const event of parseKiroJsonEvents(text, state)) processEvent(event);
      for (const chunk of pending.splice(0)) yield chunk;
    }
    const tail = decoder.decode();
    if (tail) {
      for (const event of parseKiroJsonEvents(tail, state)) processEvent(event);
    }
    for (const event of parseKiroJsonEvents("", state)) processEvent(event);
  } finally {
    reader.releaseLock();
  }

  const [flushContent, flushReasoningValue] = splitter.flush();
  let flushReasoning = flushReasoningValue;
  if (hasNativeReasoning) flushReasoning = "";
  emitContent(flushContent, flushReasoning);
  for (const call of parseKiroBracketToolCalls(totalContent)) {
    const idx = toolCallCount;
    toolCallCount += 1;
    writeChunk(
      { tool_calls: [{ index: idx, id: call.id, type: "function", function: { name: call.name, arguments: "" } }] },
      null,
      null
    );
    writeChunk(
      { tool_calls: [{ index: idx, function: { arguments: call.arguments } }] },
      null,
      null
    );
  }
  const finish = toolCallCount > 0 ? "tool_calls" : "stop";
  const usage = explicitUsage ?? kiroUsageFromContext(model, contextUsagePercentage, outputText);
  writeChunk({}, finish, usage);
  pending.push("data: [DONE]\n\n");
  for (const chunk of pending.splice(0)) yield chunk;
  void flushContent;
  void flushReasoning;
}

export function kiroSseStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  parseThinking: boolean
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformKiroSse(source, model, parseThinking)[Symbol.asyncIterator]();
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
