import { numberFromAny, randomId, stringValue } from "#providers/lib/helpers.ts";

type Json = Record<string, unknown>;

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
    if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
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
