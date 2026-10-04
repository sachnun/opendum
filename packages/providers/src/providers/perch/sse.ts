import { randomId, stringValue } from "#providers/lib/helpers.ts";

type Json = Record<string, unknown>;

export class PerchUpstreamError extends Error {
  readonly quota: boolean;
  constructor(message: string, quota: boolean) {
    super(message);
    this.name = "PerchUpstreamError";
    this.quota = quota;
  }
}

function perchUsageToChatUsage(raw: unknown): Json | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Json;
  const int = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && value > 0 ? Math.trunc(value) : 0;
  };
  const input = int("inputTokens");
  const output = int("outputTokens");
  const cacheRead = int("cacheReadInputTokens");
  if (input === 0 && output === 0 && cacheRead === 0) return null;
  const promptTokens = input + cacheRead;
  const out: Json = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
  return out;
}

function perchErrorMessage(event: Json): string {
  const text = stringValue(event.error);
  if (text) return text;
  if (event.error !== undefined && event.error !== null) return JSON.stringify(event.error);
  return "";
}

function perchQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return ["allowance", "quota", "limit", "usage", "billing", "credit"].some((marker) =>
    lower.includes(marker)
  );
}

function perchEventToolCalls(event: Json): unknown[] {
  if (Array.isArray(event.toolCalls)) return event.toolCalls;
  if (Array.isArray(event.tool_calls)) return event.tool_calls;
  return [];
}

function perchToolSealedArguments(call: Json): string {
  const text = stringValue(call.arguments);
  if (text) return text;
  if (call.arguments !== undefined && call.arguments !== null) return JSON.stringify(call.arguments);
  return "";
}

function perchToolArgumentsDelta(call: Json, sealed: boolean): string {
  const raw = stringValue(call.rawArgumentsText);
  if (raw) return raw;
  if (sealed) return perchToolSealedArguments(call);
  return "";
}

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

export async function perchSseToChatCompletion(
  resp: Response,
  model: string,
  includeReasoning: boolean
): Promise<Json> {
  const text = await resp.text();
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  let finishReason = "stop";
  let usage: Json | null = null;
  const orderedTools: Array<{ id: string; name: string; args: string }> = [];
  const byId = new Map<string, { id: string; name: string; args: string }>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed.startsWith(":")) continue;
    const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
    if (!payload || payload === "[DONE]") continue;
    let event: Json;
    try {
      event = JSON.parse(payload) as Json;
    } catch {
      continue;
    }
    switch (stringValue(event.type)) {
      case "reasoning_delta":
        if (includeReasoning) reasoning += stringValue(event.text);
        break;
      case "answer_delta":
        content += stringValue(event.text);
        break;
      case "tool_call_delta":
      case "tool_use_end": {
        const sealed = stringValue(event.type) === "tool_use_end";
        for (const rawCall of perchEventToolCalls(event)) {
          const call = (rawCall ?? {}) as Json;
          const id = stringValue(call.id);
          if (!id) continue;
          let tool = byId.get(id);
          if (!tool) {
            tool = { id, name: stringValue(call.name), args: "" };
            byId.set(id, tool);
            orderedTools.push(tool);
          } else if (stringValue(call.name) && !tool.name) {
            tool.name = stringValue(call.name);
          }
          if (sealed) {
            const args = perchToolSealedArguments(call);
            if (args) tool.args = args;
          } else {
            const delta = stringValue(call.rawArgumentsText);
            if (delta) tool.args += delta;
          }
        }
        break;
      }
      case "done": {
        const message = perchErrorMessage(event);
        const hasOk = typeof event.ok === "boolean";
        if (message || (hasOk && event.ok !== true)) {
          throw new PerchUpstreamError(message || "Perch request failed", perchQuotaError(message));
        }
        usage = perchUsageToChatUsage(event.usage);
        break;
      }
      default:
        break;
    }
  }

  for (const tool of orderedTools) {
    toolCalls.push({
      id: tool.id,
      type: "function",
      function: { name: tool.name, arguments: tool.args.trim() || "{}" },
    });
  }

  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (includeReasoning && reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    finishReason = "tool_calls";
  }
  if (!usage) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage,
  };
}
