import { contentToText, defaultStringValue, randomId, stringValue } from "#providers/lib/helpers.ts";
import { KIRO_THINKING_END, KIRO_THINKING_START, type Json } from "#providers/providers/kiro/constants.ts";
import { defaultAny } from "#providers/providers/kiro/helpers.ts";

export function kiroToolUseFromOpenAICall(rawCall: unknown): Json | null {
  const call = (rawCall ?? {}) as Json;
  const fn = (call.function ?? {}) as Json;
  const id = stringValue(call.id);
  const name = stringValue(fn.name);
  if (!id || !name) return null;
  let input: unknown = {};
  const args = stringValue(fn.arguments);
  if (args) {
    try {
      input = JSON.parse(args);
    } catch {
      input = {};
    }
  }
  return { toolUseId: id, name, input };
}

export function kiroAssistantContentAndToolUses(message: Json): { content: string; toolUses: unknown[] } {
  let content = "";
  let thinking = "";
  const toolUses: unknown[] = [];
  if (Array.isArray(message.content)) {
    for (const rawPart of message.content) {
      const part = (rawPart ?? {}) as Json;
      switch (stringValue(part.type)) {
        case "text":
        case "output_text":
          content += contentToText(part);
          break;
        case "thinking":
          thinking += defaultStringValue(part.thinking, stringValue(part.text));
          break;
        case "tool_use": {
          const id = stringValue(part.id);
          const name = stringValue(part.name);
          if (id && name) {
            toolUses.push({ toolUseId: id, name, input: defaultAny(part.input, {}) });
          }
          break;
        }
        default:
          break;
      }
    }
  } else {
    content = contentToText(message.content);
  }
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const rawCall of message.tool_calls) {
      const toolUse = kiroToolUseFromOpenAICall(rawCall);
      if (toolUse) toolUses.push(toolUse);
    }
  }
  if (thinking) {
    const wrapped = `${KIRO_THINKING_START}${thinking}${KIRO_THINKING_END}`;
    content = content ? `${wrapped}\n\n${content}` : wrapped;
  }
  return { content, toolUses };
}

export function kiroToolResultsFromContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const results: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    if (stringValue(part.type) !== "tool_result") continue;
    const id = defaultStringValue(part.tool_use_id, stringValue(part.tool_call_id));
    if (!id) continue;
    results.push(kiroToolResult(id, contentToText(part.content)));
  }
  return results;
}

export function kiroUserContentAndToolResults(content: unknown): { text: string; toolResults: unknown[] } {
  if (typeof content === "string" || (content !== null && typeof content === "object" && !Array.isArray(content))) {
    return { text: contentToText(content), toolResults: [] };
  }
  if (!Array.isArray(content) || content.length === 0) return { text: "", toolResults: [] };
  const textParts: unknown[] = [];
  const toolResults: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Json;
    if (stringValue(part.type) === "tool_result") {
      const id = defaultStringValue(part.tool_use_id, stringValue(part.tool_call_id));
      if (id) toolResults.push(kiroToolResult(id, contentToText(part.content)));
      continue;
    }
    textParts.push(raw);
  }
  return { text: contentToText(textParts), toolResults: dedupeKiroToolResults(toolResults) };
}

export function kiroToolResult(id: string, text: string): Json {
  return { toolUseId: id, status: "success", content: [{ text }] };
}

export function dedupeKiroToolResults(results: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const raw of results) {
    const result = (raw ?? {}) as Json;
    const id = stringValue(result.toolUseId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(raw);
  }
  return out;
}

export function kiroToolResultText(result: Json): string {
  return contentToText(result.content);
}

export function convertKiroMessageToHistoryItem(raw: unknown, modelId: string): Json | null {
  const message = (raw ?? {}) as Json;
  const role = stringValue(message.role);
  if (role === "assistant") {
    const { content, toolUses } = kiroAssistantContentAndToolUses(message);
    if (!content && toolUses.length === 0) return null;
    const assistant: Json = { content };
    if (toolUses.length > 0) assistant.toolUses = toolUses;
    return { assistantResponseMessage: assistant };
  }
  if (role === "tool") {
    const text = contentToText(message.content);
    let toolResults = kiroToolResultsFromContent(message.content);
    if (toolResults.length === 0) {
      toolResults = [kiroToolResult(defaultStringValue(message.tool_call_id, randomId("toolu")), text)];
    }
    return {
      userInputMessage: {
        content: "Tool results provided.",
        modelId,
        origin: "AI_EDITOR",
        userInputMessageContext: { toolResults: dedupeKiroToolResults(toolResults) },
      },
    };
  }
  if (role === "user") {
    const { text, toolResults } = kiroUserContentAndToolResults(message.content);
    let content = text;
    if (!content) content = toolResults.length > 0 ? "Tool results provided." : "Continue";
    const userInput: Json = { content, modelId, origin: "AI_EDITOR" };
    if (toolResults.length > 0) userInput.userInputMessageContext = { toolResults };
    return { userInputMessage: userInput };
  }
  return null;
}

export function kiroUserInputHasToolResults(userInput: Json): boolean {
  const ctx = (userInput.userInputMessageContext ?? {}) as Json;
  const results = ctx.toolResults;
  return Array.isArray(results) && results.length > 0;
}
