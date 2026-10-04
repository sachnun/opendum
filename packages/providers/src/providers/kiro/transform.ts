import type { Registry } from "@opendum/models/runtime";
import {
  cloneAnyMap,
  contentToText,
  defaultEmpty,
  defaultStringValue,
  numberFromAny,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import type { ProviderAccount } from "#providers/model/types.ts";
import { KIRO_REGION } from "#providers/api/endpoints.ts";

export const KIRO_API_BASE_URL = "https://q.%s.amazonaws.com/generateAssistantResponse";
export const KIRO_THINKING_START = "<thinking>";
export const KIRO_THINKING_END = "</thinking>";

export const KIRO_THINKING_TAGS = [
  { start: "<thinking>", end: "</thinking>" },
  { start: "<think>", end: "</think>" },
  { start: "<reasoning>", end: "</reasoning>" },
  { start: "<thought>", end: "</thought>" },
];

export type Json = Record<string, unknown>;

export function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

export function defaultAny(value: unknown, fallback: unknown): unknown {
  return value !== undefined && value !== null ? value : fallback;
}

export function defaultThinkingBudget(effort: string): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 10000;
    case "high":
    case "xhigh":
      return 32000;
    default:
      return 0;
  }
}

export function joinNonEmpty(sep: string, ...values: string[]): string {
  return values.filter((value) => value.trim() !== "").join(sep);
}

export function kiroTruncate(value: string, maxLen: number): string {
  if (maxLen <= 0 || value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

export function normalizeKiroTier(rawType: string, subscriptionTitle: string): string {
  switch (rawType.trim().toUpperCase()) {
    case "Q_DEVELOPER_STANDALONE_FREE":
      return "free";
    case "Q_DEVELOPER_STANDALONE_POWER":
      return "power";
    case "Q_DEVELOPER_STANDALONE_PRO":
      return "pro";
    case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
      return "pro-plus";
    case "Q_DEVELOPER_STANDALONE":
      return "standalone";
    default:
      break;
  }
  const title = subscriptionTitle.trim().toLowerCase();
  if (!title) return "";
  if (title.includes("pro+") || title.includes("pro plus")) return "pro-plus";
  if (title.includes("power")) return "power";
  if (title.includes("pro")) return "pro";
  if (title.includes("free")) return "free";
  return title.replace(/[_-]/g, " ").trim().split(/\s+/).join("-");
}

export function kiroRegionFromArn(arn: string): string {
  const parts = arn.trim().split(":");
  if (parts.length >= 4 && parts[0] === "arn" && parts[3]) return parts[3];
  return "";
}

export function kiroApiUrlForAccount(account: ProviderAccount): string {
  let region = KIRO_REGION;
  if (account.accountId) {
    const extracted = kiroRegionFromArn(account.accountId);
    if (extracted) region = extracted;
  }
  return KIRO_API_BASE_URL.replace("%s", region);
}

export function kiroNumberAsFloat(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function kiroContextWindowSize(model: string): number {
  return model.includes("-1m") ? 1_000_000 : 200_000;
}

export function estimateKiroTokens(text: string): number {
  if (!text) return 0;
  return Math.floor((text.length + 3) / 4);
}

export function kiroUsageFromContext(model: string, contextUsagePercentage: number, outputText: string): Json {
  const outputTokens = estimateKiroTokens(outputText);
  let inputTokens = 0;
  if (contextUsagePercentage > 0) {
    const totalTokens = Math.round((kiroContextWindowSize(model) * contextUsagePercentage) / 100);
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

export function kiroReasoningContent(event: Json): string {
  const nested = event.reasoningContentEvent;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return defaultStringValue((nested as Json).text, stringValue((nested as Json).reasoning_content));
  }
  const text = stringValue(event.text);
  if (
    text &&
    (event.signature !== undefined ||
      event.redactedContent !== undefined ||
      event.redacted_content !== undefined ||
      event.type === "reasoningContentEvent")
  ) {
    return text;
  }
  return "";
}

export function firstKiroNumber(values: Json, keys: string[]): number {
  for (const key of keys) {
    const value = numberFromAny(values[key]);
    if (value > 0) return value;
  }
  return 0;
}

export function kiroUsage(event: Json): Json | null {
  let usage: Json | null = null;
  for (const key of ["usage", "tokenUsage"]) {
    const value = event[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) usage = value as Json;
  }
  if (!usage && event.type === "tokenUsage") usage = event;
  if (!usage) return null;
  const input = firstKiroNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const output = firstKiroNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  if (input <= 0 && output <= 0) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function kiroErrorMessage(event: Json): string {
  const message = stringValue(event.message);
  if (message && (event.error !== undefined || event.Error !== undefined)) return message;
  return defaultStringValue(event.error, stringValue(event.Error));
}

export class KiroParserState {
  buffer = "";
}

export function nextKiroJsonStart(buffer: string, offset: number): number {
  const patterns = [
    '{"assistantResponseEvent":', '{"toolUseEvent":', '{"reasoningContentEvent":',
    '{"metadataEvent":', '{"messageMetadataEvent":', '{"tokenUsage":', '{"usage":',
    '{"content":', '{"name":', '{"followupPrompt":', '{"input":', '{"stop":',
    '{"contextUsagePercentage":', '{"type":"reasoningContentEvent"', '{"text":',
    '{"error":', '{"Error":', '{"message":',
  ];
  let best = -1;
  for (const pattern of patterns) {
    const idx = buffer.indexOf(pattern, offset);
    if (idx >= 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

export function keepKiroParserTail(value: string): string {
  return value.length <= 64 ? value : value.slice(value.length - 64);
}

export function normalizeKiroResponseEvents(event: Json): Json[] {
  const out: Json[] = [];
  for (const key of [
    "assistantResponseEvent", "toolUseEvent", "reasoningContentEvent", "metadataEvent",
    "messageMetadataEvent", "tokenUsage", "usage",
  ]) {
    const nested = event[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const copyEvent = cloneAnyMap(nested as Json);
      copyEvent.type = key;
      if (key === "reasoningContentEvent") copyEvent.reasoningContentEvent = nested;
      out.push(copyEvent);
    }
  }
  return out.length > 0 ? out : [event];
}

export function isKiroResponseEvent(parsed: Json): boolean {
  if (kiroReasoningContent(parsed)) return true;
  if (typeof parsed.content === "string" && parsed.followupPrompt === undefined) return true;
  if (stringValue(parsed.name) && stringValue(parsed.toolUseId)) return true;
  if (typeof parsed.input === "string") return true;
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) return true;
  if (parsed.contextUsagePercentage !== undefined) return true;
  if (kiroUsage(parsed)) return true;
  if (parsed.error !== undefined || parsed.Error !== undefined || parsed.message !== undefined) return true;
  return false;
}

export function parseKiroJsonEvents(source: string, state: KiroParserState): Json[] {
  state.buffer += source;
  const events: Json[] = [];
  let cursor = 0;
  while (cursor < state.buffer.length) {
    const start = nextKiroJsonStart(state.buffer, cursor);
    if (start === -1) {
      state.buffer = keepKiroParserTail(state.buffer.slice(cursor));
      return events;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < state.buffer.length; i += 1) {
      const ch = state.buffer[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      state.buffer = state.buffer.slice(start);
      return events;
    }
    const candidate = state.buffer.slice(start, end + 1);
    cursor = end + 1;
    try {
      const parsed = JSON.parse(candidate) as Json;
      for (const event of normalizeKiroResponseEvents(parsed)) {
        if (isKiroResponseEvent(event)) events.push(event);
      }
    } catch {
      continue;
    }
  }
  state.buffer = "";
  return events;
}

export class KiroThinkingSplitter {
  private buffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private activeEndTag = "";

  constructor(enabled: boolean) {
    void enabled;
  }

  process(delta: string, final: boolean): [string, string] {
    this.buffer += delta;
    let content = "";
    let reasoning = "";
    while (this.buffer !== "") {
      if (!this.inThinking && !this.thinkingExtracted) {
        const { start, tag } = findKiroThinkingStartTag(this.buffer);
        if (start >= 0 && tag) {
          content += this.buffer.slice(0, start);
          this.buffer = this.buffer.slice(start + tag.start.length);
          this.inThinking = true;
          this.activeEndTag = tag.end;
          continue;
        }
        if (final) {
          content += this.buffer;
          this.buffer = "";
          break;
        }
        const safeLen = safeKiroUtf8PrefixLen(this.buffer, Math.max(0, this.buffer.length - maxKiroThinkingStartLen()));
        if (safeLen > 0) {
          content += this.buffer.slice(0, safeLen);
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }
      if (this.inThinking) {
        const endTag = this.activeEndTag || KIRO_THINKING_END;
        const end = findKiroRealTag(this.buffer, endTag);
        if (end >= 0) {
          reasoning += this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + endTag.length);
          this.inThinking = false;
          this.thinkingExtracted = true;
          if (this.buffer.startsWith("\n\n")) this.buffer = this.buffer.slice(2);
          continue;
        }
        if (final) {
          reasoning += this.buffer;
          this.buffer = "";
          break;
        }
        const safeLen = safeKiroUtf8PrefixLen(this.buffer, Math.max(0, this.buffer.length - endTag.length));
        if (safeLen > 0) {
          reasoning += this.buffer.slice(0, safeLen);
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }
      content += this.buffer;
      this.buffer = "";
    }
    return [content, reasoning];
  }

  flush(): [string, string] {
    return this.process("", true);
  }
}

export function safeKiroUtf8PrefixLen(value: string, maxLen: number): number {
  if (maxLen <= 0) return 0;
  if (maxLen >= value.length) return value.length;
  let len = maxLen;
  while (len > 0 && (value.charCodeAt(len) & 0xc0) === 0x80) len -= 1;
  return len;
}

export function findKiroThinkingStartTag(buffer: string): { start: number; tag: { start: string; end: string } | null } {
  let best = -1;
  let bestTag: { start: string; end: string } | null = null;
  for (const tag of KIRO_THINKING_TAGS) {
    const idx = findKiroRealTag(buffer, tag.start);
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
      bestTag = tag;
    }
  }
  return { start: best, tag: bestTag };
}

export function maxKiroThinkingStartLen(): number {
  let maxLen = 0;
  for (const tag of KIRO_THINKING_TAGS) {
    if (tag.start.length > maxLen) maxLen = tag.start.length;
  }
  return maxLen;
}

export function findKiroRealTag(buffer: string, tag: string): number {
  let pos = 0;
  let inCodeBlock = false;
  while (pos < buffer.length) {
    const tagRel = buffer.indexOf(tag, pos);
    if (tagRel === -1) return -1;
    const fenceRel = buffer.indexOf("```", pos);
    if (fenceRel !== -1 && pos + fenceRel < tagRel) {
      inCodeBlock = !inCodeBlock;
      pos += fenceRel + 3;
      continue;
    }
    if (!inCodeBlock) return tagRel;
    pos = tagRel + tag.length;
  }
  return -1;
}

export type KiroBracketToolCall = { id: string; name: string; arguments: string; raw: string };

export function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseKiroBracketToolCalls(text: string): KiroBracketToolCall[] {
  const calls: KiroBracketToolCall[] = [];
  let search = 0;
  while (search < text.length) {
    const startRel = text.indexOf("[Called ", search);
    if (startRel === -1) break;
    const start = startRel;
    const nameStart = start + "[Called ".length;
    const markerRel = text.indexOf(" with args:", nameStart);
    if (markerRel === -1) {
      search = nameStart;
      continue;
    }
    const name = text.slice(nameStart, markerRel).trim();
    let argsStart = markerRel + " with args:".length;
    while (argsStart < text.length && (text[argsStart] === " " || text[argsStart] === "\n" || text[argsStart] === "\t")) {
      argsStart += 1;
    }
    if (!name || argsStart >= text.length || text[argsStart] !== "{") {
      search = argsStart;
      continue;
    }
    const argsEnd = findBalancedJsonEnd(text, argsStart);
    if (argsEnd === -1) break;
    let closeIdx = argsEnd + 1;
    while (closeIdx < text.length && (text[closeIdx] === " " || text[closeIdx] === "\n" || text[closeIdx] === "\t")) {
      closeIdx += 1;
    }
    if (closeIdx >= text.length || text[closeIdx] !== "]") {
      search = argsEnd + 1;
      continue;
    }
    const args = text.slice(argsStart, argsEnd + 1);
    try {
      JSON.parse(args);
    } catch {
      search = closeIdx + 1;
      continue;
    }
    calls.push({ id: randomId("toolu"), name, arguments: args, raw: text.slice(start, closeIdx + 1) });
    search = closeIdx + 1;
  }
  return calls;
}

export function cleanKiroBracketToolCalls(text: string, calls: KiroBracketToolCall[]): string {
  let cleaned = text;
  for (const call of calls) {
    cleaned = cleaned.split(call.raw).join("");
  }
  return cleaned.split(/\s+/).filter((part) => part !== "").join(" ").trim();
}

export function convertKiroTools(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Json;
    let fn = (tool.function ?? {}) as Json;
    let name = stringValue(fn.name).trim();
    if (!name) {
      name = stringValue(tool.name).trim();
      fn = tool;
    }
    if (!name) continue;
    const paramsValue = defaultAny(fn.parameters, fn.input_schema);
    const params =
      paramsValue !== null && typeof paramsValue === "object" && !Array.isArray(paramsValue)
        ? (paramsValue as Json)
        : { type: "object", properties: {} };
    result.push({
      toolSpecification: {
        name,
        description: kiroTruncate(defaultStringValue(fn.description, ""), 9216),
        inputSchema: { json: params },
      },
    });
  }
  return result;
}

export function splitKiroSystemMessages(rawMessages: unknown[]): { systemPrompt: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  for (const raw of rawMessages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "system" || role === "developer") {
      const text = contentToText(msg.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    messages.push(raw);
  }
  return { systemPrompt: systemParts.join("\n\n"), messages };
}

export function mergeKiroContent(a: unknown, b: unknown): unknown {
  const aParts = Array.isArray(a) ? a : null;
  const bParts = Array.isArray(b) ? b : null;
  if (aParts && bParts) return [...aParts, ...bParts];
  if (aParts) {
    const text = stringValue(b);
    return text ? [...aParts, { type: "text", text }] : a;
  }
  if (bParts) {
    const text = stringValue(a);
    return text ? [{ type: "text", text }, ...bParts] : b;
  }
  return joinNonEmpty("\n", contentToText(a), contentToText(b));
}

export function normalizeKiroToolMessages(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  let pendingToolResults: unknown[] = [];
  const flushPending = (): void => {
    if (pendingToolResults.length === 0) return;
    normalized.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_call_id: defaultStringValue(msg.tool_call_id, randomId("toolu")),
        content: msg.content,
      });
      continue;
    }
    if (role === "assistant") {
      flushPending();
      normalized.push(raw);
      continue;
    }
    if (role === "user" && pendingToolResults.length > 0) {
      const copyMsg = cloneAnyMap(msg);
      copyMsg.content = mergeKiroContent(pendingToolResults, msg.content);
      normalized.push(copyMsg);
      pendingToolResults = [];
      continue;
    }
    normalized.push(raw);
  }
  flushPending();
  return normalized;
}

export function mergeAdjacentKiroMessages(messages: unknown[]): unknown[] {
  const merged: Json[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (merged.length > 0 && role !== "tool") {
      const last = merged[merged.length - 1];
      if (stringValue(last.role) === role) {
        last.content = mergeKiroContent(last.content, msg.content);
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          const existing = Array.isArray(last.tool_calls) ? (last.tool_calls as unknown[]) : [];
          last.tool_calls = [...existing, ...(msg.tool_calls as unknown[])];
        }
        continue;
      }
    }
    merged.push(cloneAnyMap(msg));
  }
  return merged;
}

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

export function kiroHistoryToolUseIds(history: unknown[]): Record<string, boolean> {
  const ids: Record<string, boolean> = {};
  for (const raw of history) {
    const item = (raw ?? {}) as Json;
    const assistant = (item.assistantResponseMessage ?? {}) as Json;
    const toolUses = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
    for (const rawUse of toolUses) {
      const id = stringValue(((rawUse ?? {}) as Json).toolUseId);
      if (id) ids[id] = true;
    }
  }
  return ids;
}

export function findOriginalKiroToolCall(messages: unknown[], toolUseId: string): Json | null {
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "assistant") continue;
    if (Array.isArray(msg.tool_calls)) {
      for (const rawCall of msg.tool_calls) {
        const toolUse = kiroToolUseFromOpenAICall(rawCall);
        if (toolUse && toolUse.toolUseId === toolUseId) return toolUse;
      }
    }
    if (Array.isArray(msg.content)) {
      for (const rawPart of msg.content) {
        const part = (rawPart ?? {}) as Json;
        if (stringValue(part.type) === "tool_use" && stringValue(part.id) === toolUseId) {
          return { toolUseId, name: stringValue(part.name), input: defaultAny(part.input, {}) };
        }
      }
    }
  }
  return null;
}

export function setKiroCurrentToolResults(userInput: Json, results: unknown[]): void {
  const ctx = (userInput.userInputMessageContext ?? {}) as Json;
  if (results.length > 0) ctx.toolResults = dedupeKiroToolResults(results);
  else delete ctx.toolResults;
  if (Object.keys(ctx).length > 0) userInput.userInputMessageContext = ctx;
  else delete userInput.userInputMessageContext;
  void ctx;
}

export function reconcileKiroCurrentToolResults(
  history: unknown[],
  rawMessages: unknown[],
  userInput: Json,
  modelId: string
): unknown[] {
  const ctx = (userInput.userInputMessageContext ?? {}) as Json;
  const rawResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
  if (rawResults.length === 0) return history;
  const historyIds = kiroHistoryToolUseIds(history);
  const finalResults: unknown[] = [];
  const orphanedToolUses: unknown[] = [];
  for (const raw of rawResults) {
    const result = (raw ?? {}) as Json;
    const id = stringValue(result.toolUseId);
    if (!id || historyIds[id]) {
      finalResults.push(raw);
      continue;
    }
    const original = findOriginalKiroToolCall(rawMessages, id);
    if (original) {
      orphanedToolUses.push(original);
      finalResults.push(raw);
      historyIds[id] = true;
      continue;
    }
    userInput.content = joinNonEmpty(
      "\n\n",
      stringValue(userInput.content),
      `[Output for tool call ${id}]:\n${kiroToolResultText(result)}`
    );
  }
  if (orphanedToolUses.length > 0) {
    const last = history[history.length - 1];
    if (history.length === 0 || (last as Json).assistantResponseMessage !== undefined) {
      history.push({ userInputMessage: { content: "Running tools...", modelId, origin: "AI_EDITOR" } });
    }
    history.push({
      assistantResponseMessage: { content: "I will execute the following tools.", toolUses: orphanedToolUses },
    });
  }
  setKiroCurrentToolResults(userInput, finalResults);
  return history;
}

export function injectKiroSystemPrompt(history: unknown[], systemPrompt: string): boolean {
  for (const raw of history) {
    const item = (raw ?? {}) as Json;
    const user = item.userInputMessage;
    if (user === null || typeof user !== "object" || Array.isArray(user)) continue;
    const userInput = user as Json;
    if (kiroUserInputHasToolResults(userInput)) continue;
    userInput.content = joinNonEmpty("\n\n", systemPrompt, stringValue(userInput.content));
    return true;
  }
  return false;
}

export function kiroAssistantToolUseIds(assistant: Json): Record<string, boolean> | null {
  const uses = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
  if (uses.length === 0) return null;
  const ids: Record<string, boolean> = {};
  for (const rawUse of uses) {
    const id = stringValue(((rawUse ?? {}) as Json).toolUseId);
    if (id) ids[id] = true;
  }
  return ids;
}

export function sanitizeKiroUserToolResults(user: Json, allowed: Record<string, boolean> | null): Record<string, boolean> | null {
  const ctx = (user.userInputMessageContext ?? {}) as Json;
  const results = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
  if (results.length === 0 || !allowed) return null;
  const kept: unknown[] = [];
  const keptIds: Record<string, boolean> = {};
  for (const raw of results) {
    const result = (raw ?? {}) as Json;
    const id = stringValue(result.toolUseId);
    if (id && allowed[id]) {
      kept.push(raw);
      keptIds[id] = true;
      continue;
    }
    user.content = joinNonEmpty(
      "\n\n",
      stringValue(user.content),
      `[Output for tool call ${defaultEmpty(id, "unknown")}]:\n${kiroToolResultText(result)}`
    );
  }
  setKiroCurrentToolResults(user, kept);
  return Object.keys(keptIds).length === 0 ? null : keptIds;
}

export function filterKiroAssistantToolUses(assistant: Json | null, resultIds: Record<string, boolean> | null): void {
  if (!assistant) return;
  const uses = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
  if (uses.length === 0) return;
  const kept = uses.filter((rawUse) => resultIds?.[stringValue(((rawUse ?? {}) as Json).toolUseId)] === true);
  if (kept.length > 0) assistant.toolUses = kept;
  else delete assistant.toolUses;
}

export function sanitizeKiroToolPairing(history: unknown[], currentUser: Json): unknown[] {
  const sanitized: unknown[] = [];
  let pendingAssistant: Json | null = null;
  let pendingToolIds: Record<string, boolean> | null = null;
  for (const raw of history) {
    const item = (raw ?? {}) as Json;
    const assistant = item.assistantResponseMessage;
    if (assistant !== null && typeof assistant === "object" && !Array.isArray(assistant)) {
      const assistantObj = assistant as Json;
      filterKiroAssistantToolUses(pendingAssistant, null);
      pendingAssistant = assistantObj;
      pendingToolIds = kiroAssistantToolUseIds(assistantObj);
      sanitized.push(raw);
      continue;
    }
    const user = item.userInputMessage;
    if (user !== null && typeof user === "object" && !Array.isArray(user)) {
      const resultIds = sanitizeKiroUserToolResults(user as Json, pendingToolIds);
      filterKiroAssistantToolUses(pendingAssistant, resultIds);
      pendingAssistant = null;
      pendingToolIds = null;
    }
    sanitized.push(raw);
  }
  const currentResultIds = sanitizeKiroUserToolResults(currentUser, pendingToolIds);
  filterKiroAssistantToolUses(pendingAssistant, currentResultIds);
  return sanitized;
}

export function kiroExplicitThinkingBudget(body: Json): number {
  const direct = numberFromAny(body.thinking_budget);
  if (direct > 0) return direct;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    for (const key of ["max_tokens", "budget_tokens", "thinking_budget"]) {
      const budget = numberFromAny((reasoning as Json)[key]);
      if (budget > 0) return budget;
    }
  }
  return 0;
}

export function kiroReasoningEffort(body: Json): string {
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = stringValue((reasoning as Json).effort);
    if (effort) return effort;
  }
  return stringValue(body.reasoning_effort);
}

export function kiroIncludeThoughtsFalse(body: Json): boolean {
  if (body.include_thoughts === false) return true;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const value = defaultAny((reasoning as Json).include_thoughts, (reasoning as Json).includeThoughts);
    if (value === false) return true;
  }
  return false;
}

export function kiroThinkingRequested(registry: Registry, body: Json): boolean {
  if (kiroIncludeThoughtsFalse(body) || kiroReasoningEffort(body) === "none") return false;
  if (kiroExplicitThinkingBudget(body) > 0) return true;
  const effort = kiroReasoningEffort(body);
  if (effort) return defaultThinkingBudget(effort) > 0;
  if (body.include_thoughts === true) return true;
  if (body._includeReasoning === true) return true;
  if (lastModelSegment(stringValue(body.model)).endsWith("-thinking")) return true;
  const model = stringValue(body.model);
  if (registry.isReasoningModel(model) || registry.isReasoningModel(lastModelSegment(model))) return true;
  for (const key of ["thinking_budget", "include_thoughts", "reasoning", "reasoning_effort"]) {
    if (body[key] !== undefined && body[key] !== null) return true;
  }
  return false;
}

export function kiroThinkingBudget(body: Json): number {
  const budget = kiroExplicitThinkingBudget(body);
  if (budget > 0) return budget;
  const effortBudget = defaultThinkingBudget(kiroReasoningEffort(body));
  if (effortBudget > 0) return effortBudget;
  return 20000;
}

export function buildKiroRequest(registry: Registry, body: Json): Json {
  const modelId = normalizeKiroModel(registry, stringValue(body.model));
  const conversationId = randomId("conversation");
  const tools = convertKiroTools(body.tools);
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const { systemPrompt: baseSystem, messages: withoutSystem } = splitKiroSystemMessages(rawMessages);
  let systemPrompt = baseSystem;
  const instructions = stringValue(body.instructions).trim();
  if (instructions) systemPrompt = joinNonEmpty("\n\n", instructions, systemPrompt);
  if (kiroThinkingRequested(registry, body)) {
    const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${kiroThinkingBudget(
      body
    )}</max_thinking_length>`;
    if (!systemPrompt.includes("<thinking_mode>")) systemPrompt = joinNonEmpty("\n", prefix, systemPrompt);
  }
  const messages = normalizeKiroToolMessages(mergeAdjacentKiroMessages(withoutSystem));

  const history: unknown[] = [];
  if (messages.length > 1) {
    for (const raw of messages.slice(0, messages.length - 1)) {
      const item = convertKiroMessageToHistoryItem(raw, modelId);
      if (item) history.push(item);
    }
  }

  let currentContent = "Continue";
  const currentContext: Json = {};
  if (messages.length > 0) {
    const last = (messages[messages.length - 1] ?? {}) as Json;
    const role = stringValue(last.role);
    if (role === "assistant") {
      const item = convertKiroMessageToHistoryItem(last, modelId);
      if (item) history.push(item);
      currentContent = "[system: conversation continues]";
    } else {
      const { text, toolResults } = kiroUserContentAndToolResults(last.content);
      currentContent = text;
      if (!currentContent) currentContent = toolResults.length > 0 ? "Tool results provided." : "Continue";
      if (toolResults.length > 0) currentContext.toolResults = toolResults;
    }
  }
  if (tools.length > 0) currentContext.tools = tools;

  const userInput: Json = { content: currentContent, modelId, origin: "AI_EDITOR" };
  if (Object.keys(currentContext).length > 0) userInput.userInputMessageContext = currentContext;
  if (kiroUserInputHasToolResults(userInput) && stringValue(userInput.content) === "Continue") {
    userInput.content = "Tool results provided.";
  }
  const reconciledHistory = reconcileKiroCurrentToolResults(history, rawMessages, userInput, modelId);
  if (reconciledHistory.length > 0) {
    const last = (reconciledHistory[reconciledHistory.length - 1] ?? {}) as Json;
    if (last.assistantResponseMessage === undefined) {
      reconciledHistory.push({
        assistantResponseMessage: { content: "[system: conversation continues]" },
      });
    }
  }
  if (systemPrompt) {
    if (!injectKiroSystemPrompt(reconciledHistory, systemPrompt)) {
      if (!kiroUserInputHasToolResults(userInput)) {
        userInput.content = joinNonEmpty("\n\n", systemPrompt, stringValue(userInput.content));
      }
    }
  }
  const sanitizedHistory = sanitizeKiroToolPairing(reconciledHistory, userInput);

  const conversationState: Json = {
    chatTriggerType: "MANUAL",
    conversationId,
    currentMessage: { userInputMessage: userInput },
  };
  if (sanitizedHistory.length > 0) conversationState.history = sanitizedHistory;
  return { conversationState };
}

export function normalizeKiroModel(registry: Registry, model: string): string {
  const raw = lastModelSegment(model);
  if (registry.isSupportedByProvider(raw, "kiro")) return registry.upstreamModelName(raw, "kiro");
  if (raw.endsWith("-thinking")) {
    const base = raw.slice(0, -"-thinking".length);
    if (registry.isSupportedByProvider(base, "kiro")) return registry.upstreamModelName(base, "kiro");
  }
  return registry.upstreamModelName(raw, "kiro");
}

export function convertKiroEventsToCompletion(events: Json[], model: string, parseThinking: boolean): Json {
  let content = "";
  let reasoning = "";
  let outputText = "";
  let activeToolId = "";
  let contextUsagePercentage = 0;
  let explicitUsage: Json | null = null;
  const splitter = new KiroThinkingSplitter(parseThinking);
  let hasNativeReasoning = false;
  const toolById = new Map<string, { index: number; name: string; args: string }>();

  for (const event of events) {
    if (event.contextUsagePercentage !== undefined) contextUsagePercentage = kiroNumberAsFloat(event.contextUsagePercentage);
    const usage = kiroUsage(event);
    if (usage) explicitUsage = usage;
    if (kiroErrorMessage(event)) continue;
    const reasoningDelta = kiroReasoningContent(event);
    if (reasoningDelta) {
      hasNativeReasoning = true;
      reasoning += reasoningDelta;
      outputText += reasoningDelta;
    }
    if (typeof event.content === "string" && event.followupPrompt === undefined) {
      const [textDelta, reasoningPart] = splitter.process(event.content, false);
      content += textDelta;
      if (!hasNativeReasoning) reasoning += reasoningPart;
      outputText += textDelta + reasoningPart;
    }
    const name = stringValue(event.name);
    const toolUseId = stringValue(event.toolUseId);
    if (name && toolUseId) {
      activeToolId = toolUseId;
      if (!toolById.has(toolUseId)) {
        toolById.set(toolUseId, { index: toolById.size, name, args: "" });
      }
      const input = stringValue(event.input);
      if (input) (toolById.get(toolUseId) as { args: string }).args += input;
    }
    const input = stringValue(event.input);
    if (input && !stringValue(event.name) && activeToolId) {
      const entry = toolById.get(activeToolId);
      if (entry) entry.args += input;
    }
    if (event.stop === true) activeToolId = "";
  }

  const [flushText, flushReasoning] = splitter.flush();
  content += flushText;
  if (!hasNativeReasoning) reasoning += flushReasoning;
  outputText += flushText + flushReasoning;

  const toolCalls: Array<Json | null> = new Array(toolById.size).fill(null);
  for (const [id, call] of toolById) {
    toolCalls[call.index] = {
      id,
      type: "function",
      function: { name: call.name, arguments: defaultEmpty(call.args, "{}") },
    };
  }
  const bracketCalls = parseKiroBracketToolCalls(content);
  if (bracketCalls.length > 0) {
    content = cleanKiroBracketToolCalls(content, bracketCalls);
    for (const call of bracketCalls) {
      toolCalls.push({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      });
    }
  }

  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish = toolCalls.length > 0 ? "tool_calls" : "stop";
  const usage = explicitUsage ?? kiroUsageFromContext(model, contextUsagePercentage, outputText);
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

