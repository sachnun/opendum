import { randomId, stringValue } from "#providers/lib/helpers.ts";

import {
  PerchUpstreamError,
  perchErrorMessage,
  perchEventToolCalls,
  perchQuotaError,
  perchToolSealedArguments,
  perchUsageToChatUsage,
} from "./parse.ts";

type Json = Record<string, unknown>;

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
