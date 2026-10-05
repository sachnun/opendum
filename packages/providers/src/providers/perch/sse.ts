import { randomId, stringValue } from "#providers/lib/helpers.ts";
import {
  perchErrorMessage,
  perchEventToolCalls,
  perchToolArgumentsDelta,
  perchUsageToChatUsage,
} from "./parse.ts";

export { perchSseToChatCompletion } from "./completion.ts";
export { PerchUpstreamError } from "./parse.ts";

type Json = Record<string, unknown>;

function perchWriteChunk(
  out: string[],
  completionId: string,
  model: string,
  delta: Json,
  finish: unknown,
  usage?: Json | null
): void {
  const chunk: Json = {
    id: completionId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) chunk.usage = usage;
  out.push(`data: ${JSON.stringify(chunk)}\n\n`);
}

function perchToolDeltaChunk(
  out: string[],
  completionId: string,
  model: string,
  index: number,
  withId: boolean,
  id: string,
  withName: boolean,
  name: string,
  args: string
): void {
  const toolDelta: Json = { index };
  const fn: Json = {};
  if (withId) {
    toolDelta.id = id;
    toolDelta.type = "function";
  }
  if (withName) fn.name = name;
  if (args) fn.arguments = args;
  toolDelta.function = fn;
  perchWriteChunk(out, completionId, model, { tool_calls: [toolDelta] }, null);
}

async function* transformPerchSseToChat(
  source: ReadableStream<Uint8Array>,
  model: string,
  includeReasoning: boolean
): AsyncGenerator<string> {
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  let nextToolIndex = 0;
  const tools = new Map<string, { index: number; name: string; emittedArgs: boolean }>();
  let doneFlag = false;

  const ensureRole = (out: string[]): void => {
    if (sentRole) return;
    sentRole = true;
    perchWriteChunk(out, completionId, model, { role: "assistant", content: "" }, null);
  };

  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const out = handleLine(line);
        for (const chunk of out) yield chunk;
        if (doneFlag) return;
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) {
      const out = handleLine(line);
      for (const chunk of out) yield chunk;
      if (doneFlag) return;
    }
  } finally {
    reader.releaseLock();
  }
  const out: string[] = [];
  perchWriteChunk(out, completionId, model, {}, "stop", null);
  out.push("data: [DONE]\n\n");
  for (const chunk of out) yield chunk;

  function handleLine(line: string): string[] {
    const out: string[] = [];
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed.startsWith(":")) return out;
    const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
    if (!payload || payload === "[DONE]") return out;
    let event: Json;
    try {
      event = JSON.parse(payload) as Json;
    } catch {
      return out;
    }
    switch (stringValue(event.type)) {
      case "reasoning_delta": {
        if (!includeReasoning) break;
        ensureRole(out);
        const delta = stringValue(event.text);
        if (delta) perchWriteChunk(out, completionId, model, { reasoning_content: delta }, null);
        break;
      }
      case "answer_delta": {
        ensureRole(out);
        const delta = stringValue(event.text);
        if (delta) perchWriteChunk(out, completionId, model, { content: delta }, null);
        break;
      }
      case "tool_call_delta":
      case "tool_use_end": {
        const sealed = stringValue(event.type) === "tool_use_end";
        for (const rawCall of perchEventToolCalls(event)) {
          const call = (rawCall ?? {}) as Json;
          const id = stringValue(call.id);
          if (!id) continue;
          let state = tools.get(id);
          if (!state) {
            ensureRole(out);
            const name = stringValue(call.name);
            state = { index: nextToolIndex, name, emittedArgs: false };
            tools.set(id, state);
            nextToolIndex += 1;
            perchToolDeltaChunk(out, completionId, model, state.index, true, id, name !== "", name, "");
          }
          const name = stringValue(call.name);
          if (name && !state.name) {
            state.name = name;
            perchToolDeltaChunk(out, completionId, model, state.index, false, "", true, name, "");
          }
          const args = perchToolArgumentsDelta(call, sealed);
          if (!args) continue;
          if (sealed && state.emittedArgs) continue;
          state.emittedArgs = true;
          perchToolDeltaChunk(out, completionId, model, state.index, false, "", false, "", args);
        }
        break;
      }
      case "done": {
        const ok = event.ok === true;
        if (!ok) {
          const message = perchErrorMessage(event);
          if (message) {
            ensureRole(out);
            perchWriteChunk(out, completionId, model, { content: message }, null);
          }
        }
        const finish = tools.size > 0 && ok ? "tool_calls" : "stop";
        perchWriteChunk(out, completionId, model, {}, finish, perchUsageToChatUsage(event.usage));
        out.push("data: [DONE]\n\n");
        doneFlag = true;
        break;
      }
      default:
        break;
    }
    return out;
  }
}

export function perchSseToChatStream(
  source: ReadableStream<Uint8Array>,
  model: string,
  includeReasoning: boolean
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformPerchSseToChat(source, model, includeReasoning)[Symbol.asyncIterator]();
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

