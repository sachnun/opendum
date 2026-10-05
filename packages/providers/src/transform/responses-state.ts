import { numberFromAny, randomId, stringValue } from "#providers/lib/helpers.ts";
import { sseDataLines } from "#providers/lib/sse.ts";
import {
  responsesFunctionCallItem,
  responsesMessageItem,
  responsesReasoningItem,
  responsesUsageFromChat,
  toResponsesApiId,
} from "#providers/transform/responses-core.ts";

type Json = Record<string, unknown>;

class ResponsesSseState {
  private sequence = 0;
  private readonly items: unknown[] = [];
  private openKind = "";
  private openId = "";
  private openIndex = 0;
  private openText = "";
  private readonly tools = new Map<number, { index: number; id: string; name: string; args: string }>();
  private toolOrder: number[] = [];

  constructor(
    private readonly write: ((event: Json) => void) | undefined,
    private readonly model: string,
    readonly responseId: string
  ) {}

  finishReason = "";
  usage: Json = {};

  emit(event: Json): void {
    if (!this.write) return;
    event.sequence_number = this.sequence;
    this.sequence += 1;
    this.write(event);
  }

  private appendItem(item: Json, index: number): void {
    this.emit({ type: "response.output_item.done", output_index: index, item });
    this.items.push(item);
  }

  private closeOpenItem(): void {
    if (!this.openKind) return;
    let item: Json | null = null;
    if (this.openKind === "reasoning") {
      item = responsesReasoningItem(this.openText);
      item.id = this.openId;
    } else if (this.openKind === "text") {
      item = responsesMessageItem(this.openText);
      item.id = this.openId;
    }
    if (item) this.appendItem(item, this.openIndex);
    this.openKind = "";
    this.openId = "";
    this.openText = "";
  }

  private closeTool(index: number): void {
    const tool = this.tools.get(index);
    if (!tool) return;
    this.appendItem(responsesFunctionCallItem(tool.id, tool.name, tool.args), tool.index);
    this.tools.delete(index);
  }

  closeTools(): void {
    for (const index of this.toolOrder) this.closeTool(index);
    this.toolOrder = [];
  }

  private closeAll(): void {
    this.closeTools();
    this.closeOpenItem();
  }

  private ensureItem(kind: "reasoning" | "text", id: string): void {
    if (this.openKind === kind && this.openId === id) return;
    this.closeTools();
    this.closeOpenItem();
    this.openKind = kind;
    this.openId = id;
    this.openIndex = this.items.length + this.tools.size;
    const item: Json =
      kind === "reasoning"
        ? { id, type: "reasoning", status: "in_progress", summary: [] }
        : { id, type: "message", role: "assistant", status: "in_progress", content: [] };
    this.emit({ type: "response.output_item.added", output_index: this.openIndex, item });
  }

  addReasoning(text: string): void {
    if (!text) return;
    this.ensureItem("reasoning", "reasoning");
    this.openText += text;
    this.emit({
      type: "response.reasoning_text.delta",
      delta: text,
      item_id: this.openId,
      output_index: this.openIndex,
      content_index: 0,
    });
  }

  addText(text: string): void {
    if (!text) return;
    this.ensureItem("text", "message");
    this.openText += text;
    this.emit({
      type: "response.output_text.delta",
      delta: text,
      item_id: this.openId,
      output_index: this.openIndex,
      content_index: 0,
    });
  }

  addToolDelta(index: number, id: string, name: string, args: string): void {
    let tool = this.tools.get(index);
    if (!tool) {
      this.ensureClosed();
      const toolId = id || randomId("fc");
      tool = { index: this.items.length + this.tools.size, id: toolId, name: "", args: "" };
      this.tools.set(index, tool);
      this.toolOrder.push(index);
      this.emit({
        type: "response.output_item.added",
        output_index: tool.index,
        item: {
          id: tool.id,
          type: "function_call",
          status: "in_progress",
          call_id: tool.id,
          name,
          arguments: "",
        },
      });
    }
    if (name && !tool.name) tool.name = name;
    if (args) {
      tool.args += args;
      this.emit({
        type: "response.function_call_arguments.delta",
        delta: args,
        item_id: tool.id,
        output_index: tool.index,
      });
    }
  }

  private ensureClosed(): void {
    this.closeOpenItem();
  }

  complete(): void {
    this.closeAll();
    const response: Json = {
      id: this.responseId,
      object: "response",
      model: this.model,
      output: this.items,
      status: "completed",
      usage: responsesUsageFromChat(this.usage),
    };
    let eventType = "response.completed";
    if (this.finishReason === "length") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "max_output_tokens" };
      eventType = "response.incomplete";
    }
    this.emit({ type: eventType, response });
  }
}

async function* transformChatSseToResponses(
  source: ReadableStream<Uint8Array>,
  model: string
): AsyncGenerator<string> {
  const buffer: string[] = [];
  const state = new ResponsesSseState(
    (event) => buffer.push(`data: ${JSON.stringify(event)}\n\n`),
    model,
    randomId("resp")
  );
  state.emit({
    type: "response.created",
    response: {
      id: state.responseId,
      object: "response",
      model,
      status: "in_progress",
      output: [],
    },
  });
  for (const chunk of buffer.splice(0)) yield chunk;

  for await (const data of sseDataLines(source)) {
    if (!data) continue;
    if (data === "[DONE]") break;
    let chunk: Json;
    try {
      chunk = JSON.parse(data) as Json;
    } catch {
      continue;
    }
    const usage = chunk.usage;
    if (usage !== null && typeof usage === "object" && Object.keys(usage as Json).length > 0) {
      state.usage = usage as Json;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    if (choices.length === 0) continue;
    const choice = (choices[0] ?? {}) as Json;
    if (choice.usage !== null && typeof choice.usage === "object") {
      const choiceUsage = choice.usage as Json;
      if (Object.keys(choiceUsage).length > 0) state.usage = choiceUsage;
    }
    const finishReason = stringValue(choice.finish_reason);
    if (finishReason) state.finishReason = finishReason;
    const delta = (choice.delta ?? {}) as Json;
    state.addReasoning(stringValue(delta.reasoning_content));
    state.addText(stringValue(delta.content));
    const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const raw of tcs) {
      const tc = (raw ?? {}) as Json;
      const fn = (tc.function ?? {}) as Json;
      state.addToolDelta(
        numberFromAny(tc.index),
        toResponsesApiId(stringValue(tc.id)),
        stringValue(fn.name),
        stringValue(fn.arguments)
      );
    }
    for (const chunkOut of buffer.splice(0)) yield chunkOut;
  }
  state.complete();
  for (const chunkOut of buffer.splice(0)) yield chunkOut;
}

export function chatSseToResponsesStream(
  source: ReadableStream<Uint8Array>,
  model: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformChatSseToResponses(source, model)[Symbol.asyncIterator]();
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
