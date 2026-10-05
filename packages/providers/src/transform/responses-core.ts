import { defaultStringValue, numberFromAny, randomId } from "#providers/lib/helpers.ts";

type Json = Record<string, unknown>;

export function toResponsesApiId(id: string): string {
  if (!id) return randomId("fc");
  if (id.startsWith("fc_") || id.startsWith("fc-") || id.startsWith("apc_")) return id;
  if (id.startsWith("call_")) return `fc_${id.slice("call_".length)}`;
  return `fc_${id}`;
}

export function toChatCallId(id: string): string {
  if (!id) return randomId("call");
  if (id.startsWith("call_")) return id;
  if (id.startsWith("fc_") || id.startsWith("fc-")) return `call_${id.slice(3)}`;
  return `call_${id}`;
}

export function responsesReasoningItem(text: string): Json {
  return {
    id: randomId("rs"),
    type: "reasoning",
    status: "completed",
    summary: [{ type: "summary_text", text }],
  };
}

export function responsesMessageItem(text: string): Json {
  return {
    id: randomId("msg"),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

export function responsesFunctionCallItem(id: string, name: string, args: string): Json {
  return {
    id,
    type: "function_call",
    status: "completed",
    call_id: id,
    name,
    arguments: defaultStringValue(args, "{}"),
  };
}

export function responsesUsageFromChat(usage: Json): Json {
  const input = numberFromAny(usage.prompt_tokens);
  const output = numberFromAny(usage.completion_tokens);
  let cached = 0;
  let write = 0;
  const details = usage.prompt_tokens_details;
  if (details !== null && typeof details === "object") {
    cached = numberFromAny((details as Json).cached_tokens);
    write = numberFromAny((details as Json).cache_write_tokens);
  }
  let reasoning = 0;
  const completionDetails = usage.completion_tokens_details;
  if (completionDetails !== null && typeof completionDetails === "object") {
    reasoning = numberFromAny((completionDetails as Json).reasoning_tokens);
  }
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: write },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}
