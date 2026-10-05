import { cloneMapExcept, stringValue } from "../transport/helpers.ts";
import { usageFromJson } from "../metering/usage.ts";

type Json = Record<string, unknown>;

export function transformAnthropicToOpenAI(body: Json): Json {
  const payload = cloneMapExcept(body, "system", "thinking", "output_config");
  if (payload.max_tokens === undefined) payload.max_tokens = 4096;
  if (Array.isArray(body.tools)) payload.tools = convertAnthropicTools(body.tools);
  if (body.tool_choice !== undefined) payload.tool_choice = convertAnthropicToolChoice(body.tool_choice);
  const messages: unknown[] = [];
  if (body.system !== undefined && body.system !== null) {
    messages.push({ role: "system", content: anthropicSystemToText(body.system) });
  }
  const toolResultIds = anthropicToolResultIds(body.messages);
  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) messages.push(...convertAnthropicMessage(raw, toolResultIds));
  }
  payload.messages = messages;
  applyAnthropicThinkingParams(payload, body);
  return payload;
}

function convertAnthropicMessage(raw: unknown, toolResultIds: Set<string>): unknown[] {
  const msg = (raw ?? {}) as Json;
  const role = stringValue(msg.role);
  if (typeof msg.content === "string") return [{ role, content: msg.content }];
  if (Array.isArray(msg.content)) {
    const converted = convertAnthropicContentBlocks(msg.content, toolResultIds);
    const messages: unknown[] = [...converted.extraMessages];
    if (converted.parts.length > 0 || converted.toolCalls.length > 0) {
      const message: Json = { role, content: converted.contentValue() };
      if (converted.toolCalls.length > 0) message.tool_calls = converted.toolCalls;
      messages.push(message);
    }
    return messages;
  }
  return [];
}

function convertAnthropicTools(tools: unknown[]): unknown[] {
  const converted: unknown[] = [];
  for (const raw of tools) {
    const tool = (raw ?? {}) as Json;
    if (tool.function !== undefined) {
      converted.push(tool);
      continue;
    }
    const name = stringValue(tool.name);
    if (!name) continue;
    const parameters = tool.input_schema ?? {};
    converted.push({
      type: "function",
      function: { name, description: stringValue(tool.description), parameters },
    });
  }
  return converted;
}

function convertAnthropicToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
    return toolChoice;
  }
  if (toolChoice === null || typeof toolChoice !== "object" || Array.isArray(toolChoice)) return toolChoice;
  const choice = toolChoice as Json;
  if (choice.function != null) return choice;
  switch (stringValue(choice.type)) {
    case "auto":
      return "auto";
    case "any":
    case "required":
      return "required";
    case "tool":
    case "function": {
      let name = stringValue(choice.name);
      if (!name && choice.function !== null && typeof choice.function === "object") {
        name = stringValue((choice.function as Json).name);
      }
      return { type: "function", function: { name } };
    }
    case "none":
      return "none";
    default:
      return toolChoice;
  }
}

function applyAnthropicThinkingParams(payload: Json, body: Json): void {
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;
  const thinking = body.thinking;
  if (thinking === null || typeof thinking !== "object" || Array.isArray(thinking)) return;
  const t = thinking as Json;
  if (t.type === "adaptive") {
    payload.reasoning_effort = anthropicEffort(body);
    payload._includeReasoning = true;
    return;
  }
  if (t.type !== "enabled") return;
  payload.thinking_budget = t.budget_tokens ?? 10000;
  payload._includeReasoning = true;
}

function anthropicEffort(body: Json): string {
  const outputConfig = body.output_config;
  if (outputConfig !== null && typeof outputConfig === "object" && !Array.isArray(outputConfig)) {
    const effort = stringValue((outputConfig as Json).effort);
    if (effort) return effort;
  }
  return "high";
}

type ConvertedBlocks = {
  parts: unknown[];
  toolCalls: unknown[];
  extraMessages: unknown[];
};

function convertAnthropicContentBlocks(blocks: unknown[], toolResultIds: Set<string>): ConvertedBlocks & { contentValue(): unknown } {
  const parts: unknown[] = [];
  const toolCalls: unknown[] = [];
  const extraMessages: unknown[] = [];
  for (const raw of blocks) {
    const block = (raw ?? {}) as Json;
    switch (stringValue(block.type)) {
      case "text": {
        const text = stringValue(block.text);
        if (text) parts.push({ type: "text", text });
        break;
      }
      case "image": {
        const source = block.source;
        if (source !== null && typeof source === "object" && !Array.isArray(source)) {
          const url = stringValue((source as Json).url);
          if (url) parts.push({ type: "image_url", image_url: { url } });
        }
        break;
      }
      case "tool_use": {
        const id = stringValue(block.id);
        if (id && !toolResultIds.has(id)) continue;
        let args = "{}";
        if (block.input !== undefined && block.input !== null) args = JSON.stringify(block.input);
        toolCalls.push({
          id,
          type: "function",
          function: { name: stringValue(block.name), arguments: args },
        });
        break;
      }
      case "tool_result":
        extraMessages.push({
          role: "tool",
          tool_call_id: stringValue(block.tool_use_id),
          content: anthropicToolResultToText(block.content),
        });
        break;
      default:
        break;
    }
  }
  return {
    parts,
    toolCalls,
    extraMessages,
    contentValue(): unknown {
      if (parts.length === 0) return null;
      const texts: string[] = [];
      for (const raw of parts) {
        const part = raw as Json;
        if (part.type !== "text") return parts;
        texts.push(stringValue(part.text));
      }
      return texts.join("");
    },
  };
}

function anthropicToolResultIds(rawMessages: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(rawMessages)) return ids;
  for (const raw of rawMessages) {
    const msg = (raw ?? {}) as Json;
    if (!Array.isArray(msg.content)) continue;
    for (const rawBlock of msg.content) {
      const block = (rawBlock ?? {}) as Json;
      if (block.type !== "tool_result") continue;
      const id = stringValue(block.tool_use_id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function transformOpenAIToAnthropic(openAi: Json, model: string): Json {
  const content: unknown[] = [];
  let stopReason = "end_turn";
  const choices = Array.isArray(openAi.choices) ? openAi.choices : [];
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Json;
    const message = (choice.message ?? {}) as Json;
    appendOpenAiMessageContent(content, message);
    const result = appendOpenAiToolCalls(content, message, stopReason);
    stopReason = result.stopReason;
    if (stringValue(choice.finish_reason) === "length") stopReason = "max_tokens";
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  const counts = usageFromJson(openAi);
  const usage: Json = { input_tokens: counts.inputTokens, output_tokens: counts.outputTokens };
  if (counts.cachedTokens > 0) usage.cache_read_input_tokens = counts.cachedTokens;
  if (counts.cacheWriteTokens > 0) usage.cache_creation_input_tokens = counts.cacheWriteTokens;
  return {
    id: `msg_${stringValue(openAi.id) || new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

function appendOpenAiMessageContent(content: unknown[], message: Json): void {
  const reasoning = stringValue(message.reasoning_content);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  const text = stringValue(message.content);
  if (text) content.push({ type: "text", text });
}

function appendOpenAiToolCalls(
  content: unknown[],
  message: Json,
  stopReason: string
): { stopReason: string } {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = (raw ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    let input: Json;
    try {
      input = JSON.parse(stringValue(fn.arguments) || "{}") as Json;
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: stringValue(call.id), name: stringValue(fn.name), input });
  }
  return { stopReason: calls.length > 0 ? "tool_use" : stopReason };
}

function anthropicSystemToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const raw of value) {
      const block = (raw ?? {}) as Json;
      if (block.type === "text") parts.push(stringValue(block.text));
    }
    return parts.join("\n");
  }
  return "";
}

function anthropicToolResultToText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? "");
}
