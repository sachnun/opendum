import { stringValue, defaultStringValue } from "../../providers/http.js";
import { usageFromJSON } from "../stream.js";

export function transformAnthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...body };
  for (const key of ["system", "thinking", "output_config"]) {
    delete payload[key];
  }
  if (payload["max_tokens"] === undefined) {
    payload["max_tokens"] = 4096;
  }
  if (Array.isArray(body["tools"])) {
    payload["tools"] = convertAnthropicTools(body["tools"] as unknown[]);
  }
  if (body["tool_choice"] !== undefined) {
    payload["tool_choice"] = convertAnthropicToolChoice(body["tool_choice"]);
  }
  const messages: unknown[] = [];
  if (body["system"] !== undefined && body["system"] !== null) {
    messages.push({ role: "system", content: anthropicSystemToText(body["system"]) });
  }
  const toolResultIDs = anthropicToolResultIDs(body["messages"]);
  if (Array.isArray(body["messages"])) {
    for (const raw of body["messages"]) {
      messages.push(...convertAnthropicMessage(raw, toolResultIDs));
    }
  }
  payload["messages"] = messages;
  applyAnthropicThinkingParams(payload, body);
  return payload;
}

function convertAnthropicMessage(raw: unknown, toolResultIDs: Record<string, boolean>): unknown[] {
  if (!raw || typeof raw !== "object") return [];
  const msg = raw as Record<string, unknown>;
  const role = stringValue(msg["role"]);
  const content = msg["content"];
  if (typeof content === "string") {
    return [{ role, content }];
  }
  if (Array.isArray(content)) {
    const converted = convertAnthropicContentBlocks(content, toolResultIDs);
    const messages: unknown[] = [...converted.extraMessages];
    if (converted.parts.length > 0 || converted.toolCalls.length > 0) {
      const message: Record<string, unknown> = { role, content: converted.contentValue() };
      if (converted.toolCalls.length > 0) {
        message["tool_calls"] = converted.toolCalls;
      }
      messages.push(message);
    }
    return messages;
  }
  return [];
}

function convertAnthropicTools(tools: unknown[]): unknown[] {
  const converted: unknown[] = [];
  for (const raw of tools) {
    const tool = (raw ?? {}) as Record<string, unknown>;
    if (tool["function"] !== undefined) {
      converted.push(raw);
      continue;
    }
    const name = stringValue(tool["name"]);
    if (name === "") continue;
    let parameters = tool["input_schema"];
    if (parameters === undefined || parameters === null) parameters = {};
    converted.push({ type: "function", function: { name, description: stringValue(tool["description"]), parameters } });
  }
  return converted;
}

function convertAnthropicToolChoice(toolChoice: unknown): unknown {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
    return toolChoice;
  }
  if (!toolChoice || typeof toolChoice !== "object") return toolChoice;
  const choiceMap = toolChoice as Record<string, unknown>;
  if (choiceMap["function"] !== undefined) return choiceMap;
  switch (stringValue(choiceMap["type"])) {
    case "auto":
      return "auto";
    case "any":
    case "required":
      return "required";
    case "tool":
    case "function": {
      let name = stringValue(choiceMap["name"]);
      if (name === "") {
        const fn = choiceMap["function"];
        if (fn && typeof fn === "object") {
          name = stringValue((fn as Record<string, unknown>)["name"]);
        }
      }
      return { type: "function", function: { name } };
    }
    case "none":
      return "none";
  }
  return toolChoice;
}

function applyAnthropicThinkingParams(payload: Record<string, unknown>, body: Record<string, unknown>): void {
  if (body["max_tokens"] !== undefined) payload["max_tokens"] = body["max_tokens"];
  const thinking = body["thinking"];
  if (!thinking || typeof thinking !== "object") return;
  const t = thinking as Record<string, unknown>;
  if (t["type"] === "adaptive") {
    payload["reasoning_effort"] = anthropicEffort(body);
    payload["_includeReasoning"] = true;
    return;
  }
  if (t["type"] !== "enabled") return;
  if (t["budget_tokens"] === undefined) {
    payload["thinking_budget"] = 10000;
  } else {
    payload["thinking_budget"] = t["budget_tokens"];
  }
  payload["_includeReasoning"] = true;
}

function anthropicEffort(body: Record<string, unknown>): string {
  const outputConfig = body["output_config"];
  if (outputConfig && typeof outputConfig === "object") {
    const effort = stringValue((outputConfig as Record<string, unknown>)["effort"]);
    if (effort !== "") return effort;
  }
  return "high";
}

interface ConvertedBlocks {
  parts: unknown[];
  toolCalls: unknown[];
  extraMessages: unknown[];
  contentValue(): unknown;
}

function convertAnthropicContentBlocks(blocks: unknown[], toolResultIDs: Record<string, boolean>): ConvertedBlocks {
  const result: ConvertedBlocks = { parts: [], toolCalls: [], extraMessages: [], contentValue: () => null };
  result.contentValue = () => {
    if (result.parts.length === 0) return null;
    const texts: string[] = [];
    for (const raw of result.parts) {
      const part = (raw ?? {}) as Record<string, unknown>;
      if (!part || part["type"] !== "text") return result.parts;
      texts.push(stringValue(part["text"]));
    }
    return texts.join("");
  };
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    switch (stringValue(block["type"])) {
      case "text": {
        const text = stringValue(block["text"]);
        if (text !== "") result.parts.push({ type: "text", text });
        break;
      }
      case "image": {
        const source = block["source"];
        if (source && typeof source === "object") {
          const url = stringValue((source as Record<string, unknown>)["url"]);
          if (url !== "") result.parts.push({ type: "image_url", image_url: { url } });
        }
        break;
      }
      case "tool_use": {
        const id = stringValue(block["id"]);
        if (id !== "" && !toolResultIDs[id]) continue;
        let args = "{}";
        if (block["input"] !== undefined) {
          args = JSON.stringify(block["input"]);
        }
        result.toolCalls.push({ id, type: "function", function: { name: stringValue(block["name"]), arguments: args } });
        break;
      }
      case "tool_result":
        result.extraMessages.push({ role: "tool", tool_call_id: stringValue(block["tool_use_id"]), content: anthropicToolResultToText(block["content"]) });
        break;
    }
  }
  return result;
}

function anthropicToolResultIDs(rawMessages: unknown): Record<string, boolean> {
  const ids: Record<string, boolean> = {};
  if (!Array.isArray(rawMessages)) return ids;
  for (const raw of rawMessages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const blocks = msg["content"];
    if (!Array.isArray(blocks)) continue;
    for (const rawBlock of blocks) {
      const block = (rawBlock ?? {}) as Record<string, unknown>;
      if (block["type"] !== "tool_result") continue;
      const id = stringValue(block["tool_use_id"]);
      if (id !== "") ids[id] = true;
    }
  }
  return ids;
}

export function transformOpenAIToAnthropic(openAI: Record<string, unknown>, model: string): Record<string, unknown> {
  let content: unknown[] = [];
  const choices = (openAI["choices"] ?? []) as unknown[];
  let stopReason = "end_turn";
  if (choices.length > 0) {
    const choice = (choices[0] ?? {}) as Record<string, unknown>;
    const message = (choice["message"] ?? {}) as Record<string, unknown>;
    content = appendOpenAIMessageContent(content, message);
    [content, stopReason] = appendOpenAIToolCalls(content, message, stopReason);
    if (stringValue(choice["finish_reason"]) === "length") {
      stopReason = "max_tokens";
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }
  const [inputTokens, outputTokens] = usageFromJSON(openAI);
  const id = "msg_" + defaultStringValue(openAI["id"], new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14));
  return { id, type: "message", role: "assistant", content, model, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

function appendOpenAIMessageContent(content: unknown[], message: Record<string, unknown>): unknown[] {
  const reasoning = stringValue(message["reasoning_content"]);
  if (reasoning !== "") {
    content.push({ type: "thinking", thinking: reasoning });
  }
  const text = stringValue(message["content"]);
  if (text !== "") {
    content.push({ type: "text", text });
  }
  return content;
}

function appendOpenAIToolCalls(content: unknown[], message: Record<string, unknown>, stopReason: string): [unknown[], string] {
  const calls = (message["tool_calls"] ?? []) as unknown[];
  if (!Array.isArray(calls)) return [content, stopReason];
  for (const raw of calls) {
    const call = (raw ?? {}) as Record<string, unknown>;
    const fn = (call["function"] ?? {}) as Record<string, unknown>;
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(defaultStringValue(fn["arguments"], "{}")) as Record<string, unknown>;
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: stringValue(call["id"]), name: stringValue(fn["name"]), input });
  }
  if (calls.length > 0) stopReason = "tool_use";
  return [content, stopReason];
}

function anthropicSystemToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const raw of value) {
      const block = (raw ?? {}) as Record<string, unknown>;
      if (block["type"] === "text") parts.push(stringValue(block["text"]));
    }
    return parts.join("\n");
  }
  return "";
}

function anthropicToolResultToText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function contentToTextLocal(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    for (const part of value) {
      const m = (part ?? {}) as Record<string, unknown>;
      const t = stringValue(m["text"]);
      if (t !== "") chunks.push(t);
      if (m["type"] === "tool_result" && m["content"] !== undefined) chunks.push(contentToTextLocal(m["content"]));
    }
    return chunks.join("");
  }
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    for (const key of ["text", "input_text", "output_text"]) {
      const t = stringValue(item[key]);
      if (t !== "") return t;
    }
    if (item["content"] !== undefined) return contentToTextLocal(item["content"]);
  }
  return "";
}

export { contentToTextLocal };
