import { raise } from "@opendum/providers/core/errors";
import { Ids, Value } from "@opendum/providers/core/helpers";
import { Collector } from "@opendum/providers/transform/collector";
import { PerchUsage, UpstreamError, type Json } from "@opendum/providers/upstreams/perch/auth";

export class PerchToolCalls {
  static fromEvent(event: Json): unknown[] {
    if (Array.isArray(event.toolCalls)) return event.toolCalls;
    if (Array.isArray(event.tool_calls)) return event.tool_calls;
    return [];
  }

  static sealedArguments(call: Json): string {
    const text = Value.string(call.arguments);
    if (text) return text;
    if (call.arguments !== undefined && call.arguments !== null) return JSON.stringify(call.arguments);
    return "";
  }

  static deltaArguments(call: Json, sealed: boolean): string {
    const raw = Value.string(call.rawArgumentsText);
    if (raw) return raw;
    if (sealed) return PerchToolCalls.sealedArguments(call);
    return "";
  }
}

export class PerchChunks {
  static write(
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

  static tool(
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
    PerchChunks.write(out, completionId, model, { tool_calls: [toolDelta] }, null);
  }
}

export class PerchStream {
  private readonly completionId = Ids.random("chatcmpl");

  private readonly tools = new Map<string, { index: number; name: string; emittedArgs: boolean }>();

  private readonly model: string;

  private readonly includeReasoning: boolean;

  private sentRole = false;

  private nextToolIndex = 0;

  private done = false;

  constructor(model: string, includeReasoning: boolean) {
    this.model = model;
    this.includeReasoning = includeReasoning;
  }

  private ensureRole(out: string[]): void {
    if (this.sentRole) return;
    this.sentRole = true;
    PerchChunks.write(out, this.completionId, this.model, { role: "assistant", content: "" }, null);
  }

  get finished(): boolean {
    return this.done;
  }

  handle(line: string): string[] {
    const out: string[] = [];
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]" || trimmed.startsWith(":")) return out;
    const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
    if (!payload || payload === "[DONE]") return out;
    const event = Value.parseJson(payload) as Json | null;
    if (event === null) return out;
    switch (Value.string(event.type)) {
      case "reasoning_delta": {
        if (!this.includeReasoning) break;
        this.ensureRole(out);
        const delta = Value.string(event.text);
        if (delta) PerchChunks.write(out, this.completionId, this.model, { reasoning_content: delta }, null);
        break;
      }
      case "answer_delta": {
        this.ensureRole(out);
        const delta = Value.string(event.text);
        if (delta) PerchChunks.write(out, this.completionId, this.model, { content: delta }, null);
        break;
      }
      case "tool_call_delta":
      case "tool_use_end": {
        this.handleTools(event, out);
        break;
      }
      case "done": {
        const ok = event.ok === true;
        if (!ok) {
          const message = PerchUsage.errorMessage(event);
          if (message) {
            this.ensureRole(out);
            PerchChunks.write(out, this.completionId, this.model, { content: message }, null);
          }
        }
        const finish = this.tools.size > 0 && ok ? "tool_calls" : "stop";
        PerchChunks.write(
          out,
          this.completionId,
          this.model,
          {},
          finish,
          PerchUsage.toChat(event.usage)
        );
        out.push("data: [DONE]\n\n");
        this.done = true;
        break;
      }
      default:
        break;
    }
    return out;
  }

  private handleTools(event: Json, out: string[]): void {
    const sealed = Value.string(event.type) === "tool_use_end";
    for (const rawCall of PerchToolCalls.fromEvent(event)) {
      const call = (rawCall ?? {}) as Json;
      const id = Value.string(call.id);
      if (!id) continue;
      let state = this.tools.get(id);
      if (!state) {
        this.ensureRole(out);
        const name = Value.string(call.name);
        state = { index: this.nextToolIndex, name, emittedArgs: false };
        this.tools.set(id, state);
        this.nextToolIndex += 1;
        PerchChunks.tool(out, this.completionId, this.model, state.index, true, id, name !== "", name, "");
      }
      const name = Value.string(call.name);
      if (name && !state.name) {
        state.name = name;
        PerchChunks.tool(out, this.completionId, this.model, state.index, false, "", true, name, "");
      }
      const args = PerchToolCalls.deltaArguments(call, sealed);
      if (!args) continue;
      if (sealed && state.emittedArgs) continue;
      state.emittedArgs = true;
      PerchChunks.tool(out, this.completionId, this.model, state.index, false, "", false, "", args);
    }
  }

  finish(): string[] {
    const out: string[] = [];
    PerchChunks.write(out, this.completionId, this.model, {}, "stop", null);
    out.push("data: [DONE]\n\n");
    return out;
  }
}

export async function* sseGenerator(
  source: ReadableStream<Uint8Array>,
  model: string,
  includeReasoning: boolean
): AsyncGenerator<string> {
  const stream = new PerchStream(model, includeReasoning);
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
      for (const chunk of stream.handle(line)) yield chunk;
      if (stream.finished) {
        reader.releaseLock();
        return;
      }
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) {
    for (const chunk of stream.handle(line)) yield chunk;
    if (stream.finished) {
      reader.releaseLock();
      return;
    }
  }
  reader.releaseLock();
  for (const chunk of stream.finish()) yield chunk;
}

export class PerchCompletion {
  static async fromResponse(
    resp: Response,
    model: string,
    includeReasoning: boolean
  ): Promise<Json> {
    const text = await resp.text();
    const collector = new Collector({
      model,
      includeReasoning,
      nullContent: true,
      normalizeArgs: (args) => args.trim() || "{}",
      usageFallback: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "[DONE]" || trimmed.startsWith(":")) continue;
      const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
      if (!payload || payload === "[DONE]") continue;
      const event = Value.parseJson(payload) as Json | null;
      if (event === null) continue;
      switch (Value.string(event.type)) {
        case "reasoning_delta":
          collector.addReasoning(Value.string(event.text));
          break;
        case "answer_delta":
          collector.addContent(Value.string(event.text));
          break;
        case "tool_call_delta":
        case "tool_use_end": {
          const sealed = Value.string(event.type) === "tool_use_end";
          for (const rawCall of PerchToolCalls.fromEvent(event)) {
            const call = (rawCall ?? {}) as Json;
            const id = Value.string(call.id);
            if (!id) continue;
            const name = Value.string(call.name);
            if (sealed) {
              collector.addToolCall({
                key: id,
                id,
                name,
                arguments: PerchToolCalls.sealedArguments(call),
                replaceArgs: true,
              });
            } else {
              collector.addToolCall({
                key: id,
                id,
                name,
                arguments: Value.string(call.rawArgumentsText),
              });
            }
          }
          break;
        }
        case "done": {
          const message = PerchUsage.errorMessage(event);
          const hasOk = typeof event.ok === "boolean";
          if (message || (hasOk && event.ok !== true)) {
            raise(new UpstreamError(message || "Perch request failed", PerchUsage.isQuota(message)));
          }
          const usage = PerchUsage.toChat(event.usage);
          if (usage) collector.setUsage(usage);
          break;
        }
        default:
          break;
      }
    }

    return collector.toCompletion();
  }
}
