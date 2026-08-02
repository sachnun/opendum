import { createHash, randomBytes } from "node:crypto";
import type { Registry } from "../registry/index.js";
import { jsonResponse, sseResponse, stringValue, defaultStringValue, defaultAny, numberFromAny, readAllText, randomID } from "./http.js";
import { contentToText } from "./responses_transform.js";
import type { HttpClient, Provider, ProviderAccountLike, RefreshedCredentials, RequestContext, UpstreamResponse } from "./types.js";
import { markUpstreamResponseStarted } from "./latency.js";

const kiroAPIBaseURL = "https://q.%s.amazonaws.com/generateAssistantResponse";
const kiroRefreshEndpoint = "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const kiroDefaultRegion = "us-east-1";
const kiroThinkingStart = "<thinking>";
const kiroThinkingEnd = "</thinking>";

const kiroThinkingTags = [
  { start: "<thinking>", end: "</thinking>" },
  { start: "<think>", end: "</think>" },
  { start: "<reasoning>", end: "</reasoning>" },
  { start: "<thought>", end: "</thought>" },
];

export class KiroProvider implements Provider {
  constructor(private registry: Registry | null) {}

  refreshBuffer(): number {
    return 5 * 60 * 1000;
  }

  async refreshCredentials(ctx: RequestContext, client: HttpClient, refreshToken: string, _account: ProviderAccountLike): Promise<RefreshedCredentials> {
    const payload = JSON.stringify({ refreshToken: refreshToken.trim() });
    const resp = await client.fetch(kiroRefreshEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": "KiroIDE" },
      body: payload,
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const body = await readAllText(resp.body);
      throw new Error(`kiro token refresh failed: ${resp.status} ${body}`);
    }
    const token = (await readAllJSONSafe(resp.body)) as { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown };
    if (stringValue(token.accessToken) === "") {
      throw new Error("kiro token refresh returned empty access token");
    }
    let newRefreshToken = stringValue(token.refreshToken);
    if (newRefreshToken === "") newRefreshToken = refreshToken;
    let expiresIn = numberFromAny(token.expiresIn);
    if (expiresIn <= 0) expiresIn = 3600;
    const tier = await fetchKiroSubscriptionTier(client, ctx, stringValue(token.accessToken));
    return { accessToken: stringValue(token.accessToken), refreshToken: newRefreshToken, expiresAt: new Date(Date.now() + expiresIn * 1000), tier, projectId: "", email: "", accountId: "", storeAccessToken: "" };
  }

  async makeRequest(client: HttpClient, ctx: RequestContext, credentials: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    const modelName = lastModelSegment(stringValue(body["model"]));
    const thinkingEnabled = this.kiroThinkingRequested(body);
    const payload = this.buildRequest(body);
    if (account.accountId !== null && account.accountId.trim() !== "") {
      payload["profileArn"] = account.accountId.trim();
    }

    const resp = await client.fetch(kiroAPIURLForAccount(account), {
      method: "POST",
      headers: {
        authorization: "Bearer " + credentials.trim(),
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "aws-sdk-js/3.738.0 ua/2.1 lang/go api/codewhisperer#3.738.0 m/E KiroIDE",
        "x-amz-user-agent": "aws-sdk-js/3.738.0 KiroIDE",
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "amz-sdk-invocation-id": randomID("kiro"),
        "amz-sdk-request": "attempt=1; max=1",
        connection: "close",
      },
      body: JSON.stringify(payload),
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) return resp;
    if (ctx && typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);
    if (!resp.body) {
      return jsonResponse(502, { error: { message: "Kiro response stream is empty", type: "api_error" } });
    }

    if (stream) {
      return sseResponse(kiroSSEToChatSSE(resp.body, modelName, thinkingEnabled));
    }

    const rawText = await readAllText(resp.body);
    const events = parseKiroJSONEvents(rawText, newKiroParserState());
    return jsonResponse(200, convertKiroEventsToCompletion(events, modelName, thinkingEnabled));
  }

  buildRequest(body: Record<string, unknown>): Record<string, unknown> {
    const modelID = this.normalizeModel(stringValue(body["model"]));
    const conversationID = randomID("conversation");
    const tools = convertKiroTools(body["tools"]);
    const rawMessages = (body["messages"] ?? []) as unknown[];
    let systemPrompt = "";
    let messages: unknown[] = [];
    [systemPrompt, messages] = splitKiroSystemMessages(rawMessages);
    const instructions = stringValue(body["instructions"]).trim();
    if (instructions !== "") {
      systemPrompt = joinNonEmpty("\n\n", instructions, systemPrompt);
    }
    if (this.kiroThinkingRequested(body)) {
      const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${kiroThinkingBudget(body)}</max_thinking_length>`;
      if (!systemPrompt.includes("<thinking_mode>")) {
        systemPrompt = joinNonEmpty("\n", prefix, systemPrompt);
      }
    }
    messages = normalizeKiroToolMessages(mergeAdjacentKiroMessages(messages));

    const history: unknown[] = [];
    if (messages.length > 1) {
      for (const raw of messages.slice(0, -1)) {
        const item = convertKiroMessageToHistoryItem(raw, modelID);
        if (item) history.push(item);
      }
    }

    let currentContent = "Continue";
    const currentContext: Record<string, unknown> = {};
    if (messages.length > 0) {
      const last = (messages[messages.length - 1] ?? {}) as Record<string, unknown>;
      const role = stringValue(last["role"]);
      if (role === "assistant") {
        const item = convertKiroMessageToHistoryItem(last, modelID);
        if (item) history.push(item);
        currentContent = "[system: conversation continues]";
      } else {
        let toolResults: unknown[] = [];
        [currentContent, toolResults] = kiroUserContentAndToolResults(last["content"]);
        if (currentContent === "") {
          if (toolResults.length > 0) {
            currentContent = "Tool results provided.";
          } else {
            currentContent = "Continue";
          }
        }
        if (toolResults.length > 0) {
          currentContext["toolResults"] = toolResults;
        }
      }
    }
    if (tools.length > 0) {
      currentContext["tools"] = tools;
    }

    const userInput: Record<string, unknown> = { content: currentContent, modelId: modelID, origin: "AI_EDITOR" };
    if (Object.keys(currentContext).length > 0) {
      userInput["userInputMessageContext"] = currentContext;
    }
    if (kiroUserInputHasToolResults(userInput) && stringValue(userInput["content"]) === "Continue") {
      userInput["content"] = "Tool results provided.";
    }
    reconcileKiroCurrentToolResults(history, rawMessages, userInput, modelID);
    if (history.length > 0) {
      const last = (history[history.length - 1] ?? {}) as Record<string, unknown>;
      if (last && !("assistantResponseMessage" in last)) {
        history.push({ assistantResponseMessage: { content: "[system: conversation continues]" } });
      }
    }
    if (systemPrompt !== "") {
      if (!injectKiroSystemPrompt(history, systemPrompt)) {
        if (!kiroUserInputHasToolResults(userInput)) {
          userInput["content"] = joinNonEmpty("\n\n", systemPrompt, stringValue(userInput["content"]));
        }
      }
    }
    sanitizeKiroToolPairing(history, userInput);

    const conversationState: Record<string, unknown> = { chatTriggerType: "MANUAL", conversationId: conversationID, currentMessage: { userInputMessage: userInput } };
    if (history.length > 0) {
      conversationState["history"] = history;
    }
    return { conversationState };
  }

  normalizeModel(model: string): string {
    const raw = lastModelSegment(model);
    if (!this.registry) return raw;
    if (this.registry.isSupportedByProvider(raw, "kiro")) {
      return this.registry.upstreamModelName(raw, "kiro");
    }
    if (raw.endsWith("-thinking")) {
      const base = raw.slice(0, -"-thinking".length);
      if (this.registry.isSupportedByProvider(base, "kiro")) {
        return this.registry.upstreamModelName(base, "kiro");
      }
    }
    return this.registry.upstreamModelName(raw, "kiro");
  }

  kiroThinkingRequested(body: Record<string, unknown>): boolean {
    if (kiroIncludeThoughtsFalse(body) || kiroReasoningEffort(body) === "none") return false;
    if (kiroExplicitThinkingBudget(body) > 0) return true;
    const effort = kiroReasoningEffort(body);
    if (effort !== "") return defaultThinkingBudget(effort) > 0;
    if (typeof body["include_thoughts"] === "boolean" && body["include_thoughts"]) return true;
    if (typeof body["_includeReasoning"] === "boolean" && body["_includeReasoning"]) return true;
    if (lastModelSegment(stringValue(body["model"])).endsWith("-thinking")) return true;
    const model = stringValue(body["model"]);
    if (this.registry && (this.registry.isReasoningModel(model) || this.registry.isReasoningModel(lastModelSegment(model)))) return true;
    for (const key of ["thinking_budget", "include_thoughts", "reasoning", "reasoning_effort"]) {
      if (body[key] !== undefined && body[key] !== null) return true;
    }
    return false;
  }
}

export async function fetchKiroSubscriptionTier(client: HttpClient, ctx: RequestContext, accessToken: string): Promise<string> {
  try {
    const body = JSON.stringify({ origin: "AI_EDITOR" });
    const resp = await client.fetch("https://q.us-east-1.amazonaws.com/", {
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken.trim(),
        "content-type": "application/x-amz-json-1.0",
        accept: "application/json",
        "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
        "user-agent": "KiroIDE-0.7.45",
      },
      body,
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) return "";
    const payload = (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
    const record = (payload["data"] ?? payload) as Record<string, unknown>;
    const sub = (record["subscriptionInfo"] ?? {}) as Record<string, unknown>;
    return normalizeKiroTier(stringValue(sub["type"]), stringValue(sub["subscriptionTitle"]));
  } catch {
    return "";
  }
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
  }
  const title = subscriptionTitle.trim().toLowerCase();
  if (title === "") return "";
  if (title.includes("pro+") || title.includes("pro plus")) return "pro-plus";
  if (title.includes("power")) return "power";
  if (title.includes("pro")) return "pro";
  if (title.includes("free")) return "free";
  return title.replace(/_/g, " ").replace(/-/g, " ").split(/\s+/).join("-");
}

export function convertKiroTools(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    let tool = (item ?? {}) as Record<string, unknown>;
    let fn = (tool["function"] ?? {}) as Record<string, unknown>;
    let name = stringValue(fn["name"]).trim();
    if (name === "") {
      name = stringValue(tool["name"]).trim();
      fn = tool;
    }
    if (name === "") continue;
    let params = defaultAny(fn["parameters"], fn["input_schema"]);
    if (typeof params !== "object" || params === null) {
      params = { type: "object", properties: {} };
    }
    result.push({ toolSpecification: { name, description: kiroTruncate(defaultStringValue(fn["description"], ""), 9216), inputSchema: { json: params } } });
  }
  return result;
}

export function convertKiroMessageToHistoryItem(raw: unknown, modelID: string): Record<string, unknown> | null {
  const message = (raw ?? {}) as Record<string, unknown>;
  const role = stringValue(message["role"]);
  if (role === "assistant") {
    const [content, toolUses] = kiroAssistantContentAndToolUses(message);
    if (content === "" && toolUses.length === 0) return null;
    const assistant: Record<string, unknown> = { content };
    if (toolUses.length > 0) assistant["toolUses"] = toolUses;
    return { assistantResponseMessage: assistant };
  }

  if (role === "tool") {
    const text = contentToText(message["content"]);
    let toolResults = kiroToolResultsFromContent(message["content"]);
    if (toolResults.length === 0) {
      toolResults = [kiroToolResult(defaultStringValue(message["tool_call_id"], randomID("toolu")), text)];
    }
    return { userInputMessage: { content: "Tool results provided.", modelId: modelID, origin: "AI_EDITOR", userInputMessageContext: { toolResults: dedupeKiroToolResults(toolResults) } } };
  }
  if (role === "user") {
    let [text, results] = kiroUserContentAndToolResults(message["content"]);
    if (text === "") {
      if (results.length > 0) {
        text = "Tool results provided.";
      } else {
        text = "Continue";
      }
    }
    const userInput: Record<string, unknown> = { content: text, modelId: modelID, origin: "AI_EDITOR" };
    if (results.length > 0) {
      userInput["userInputMessageContext"] = { toolResults: results };
    }
    return { userInputMessage: userInput };
  }
  return null;
}

export function kiroUserContentAndToolResults(content: unknown): [string, unknown[]] {
  if (typeof content === "string") return [contentToText(content), []];
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return [contentToText(content), []];
  }
  if (!Array.isArray(content)) return ["", []];
  if (content.length === 0) return ["", []];
  const textParts: unknown[] = [];
  const toolResults: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>;
    if (stringValue(part["type"]) === "tool_result") {
      const id = defaultStringValue(part["tool_use_id"], stringValue(part["tool_call_id"]));
      if (id !== "") {
        toolResults.push(kiroToolResult(id, contentToText(part["content"])));
      }
      continue;
    }
    textParts.push(raw);
  }
  return [contentToText(textParts), dedupeKiroToolResults(toolResults)];
}

interface KiroParserState {
  buffer: string;
}

export function newKiroParserState(): KiroParserState {
  return { buffer: "" };
}

export function parseKiroJSONEvents(source: string, state: KiroParserState): Array<Record<string, unknown>> {
  state.buffer += source;
  const events: Array<Record<string, unknown>> = [];
  let cursor = 0;
  while (cursor < state.buffer.length) {
    const start = nextKiroJSONStart(state.buffer, cursor);
    if (start === -1) {
      state.buffer = keepKiroParserTail(state.buffer.slice(cursor));
      return events;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < state.buffer.length; i++) {
      const ch = state.buffer[i]!;
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
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
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
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      for (const event of normalizeKiroResponseEvents(parsed)) {
        if (isKiroResponseEvent(event)) {
          events.push(event);
        }
      }
    } catch {
      // skip
    }
  }
  state.buffer = "";
  return events;
}

const kiroJSONStartPatterns = [
  '{"assistantResponseEvent":',
  '{"toolUseEvent":',
  '{"reasoningContentEvent":',
  '{"metadataEvent":',
  '{"messageMetadataEvent":',
  '{"tokenUsage":',
  '{"usage":',
  '{"content":',
  '{"name":',
  '{"followupPrompt":',
  '{"input":',
  '{"stop":',
  '{"contextUsagePercentage":',
  '{"type":"reasoningContentEvent"',
  '{"text":',
  '{"error":',
  '{"Error":',
  '{"message":',
];

function nextKiroJSONStart(buffer: string, offset: number): number {
  let best = -1;
  for (const pattern of kiroJSONStartPatterns) {
    const idx = buffer.indexOf(pattern, offset);
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

function keepKiroParserTail(value: string): string {
  if (value.length <= 64) return value;
  return value.slice(-64);
}

export function normalizeKiroResponseEvents(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const key of ["assistantResponseEvent", "toolUseEvent", "reasoningContentEvent", "metadataEvent", "messageMetadataEvent", "tokenUsage", "usage"]) {
    const nested = event[key];
    if (nested && typeof nested === "object") {
      const copyEvent: Record<string, unknown> = { ...(nested as Record<string, unknown>), type: key };
      if (key === "reasoningContentEvent") {
        copyEvent["reasoningContentEvent"] = nested;
      }
      out.push(copyEvent);
    }
  }
  if (out.length > 0) return out;
  return [event];
}

export function isKiroResponseEvent(parsed: Record<string, unknown>): boolean {
  if (kiroReasoningContent(parsed) !== "") return true;
  if (typeof parsed["content"] === "string" && parsed["followupPrompt"] === undefined) return true;
  if (stringValue(parsed["name"]) !== "" && stringValue(parsed["toolUseId"]) !== "") return true;
  if (typeof parsed["input"] === "string") return true;
  if ("stop" in parsed && parsed["contextUsagePercentage"] === undefined) return true;
  if ("contextUsagePercentage" in parsed) return true;
  if (kiroUsage(parsed) !== null) return true;
  if (parsed["error"] !== undefined || parsed["Error"] !== undefined || parsed["message"] !== undefined) return true;
  return false;
}

export function kiroReasoningContent(event: Record<string, unknown>): string {
  const nested = event["reasoningContentEvent"];
  if (nested && typeof nested === "object") {
    return defaultStringValue((nested as Record<string, unknown>)["text"], stringValue((nested as Record<string, unknown>)["reasoning_content"]));
  }
  const text = stringValue(event["text"]);
  if (text !== "" && (event["signature"] !== undefined || event["redactedContent"] !== undefined || event["redacted_content"] !== undefined || event["type"] === "reasoningContentEvent")) {
    return text;
  }
  return "";
}

export function kiroUsage(event: Record<string, unknown>): Record<string, unknown> | null {
  let usage = event["usage"] as Record<string, unknown> | undefined;
  if (usage === undefined) usage = event["tokenUsage"] as Record<string, unknown> | undefined;
  if (usage === undefined && event["type"] === "tokenUsage") usage = event;
  if (usage === undefined) return null;
  const input = firstKiroNumber(usage, "inputTokens", "input_tokens", "promptTokens", "prompt_tokens");
  const output = firstKiroNumber(usage, "outputTokens", "output_tokens", "completionTokens", "completion_tokens");
  if (input <= 0 && output <= 0) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function kiroErrorMessage(event: Record<string, unknown>): string {
  const message = stringValue(event["message"]);
  if (message !== "" && (event["error"] !== undefined || event["Error"] !== undefined)) return message;
  if (typeof event["error"] === "string") return event["error"];
  return stringValue(event["Error"]);
}

function firstKiroNumber(values: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const number = numberFromAny(values[key]);
    if (number > 0) return number;
  }
  return 0;
}

export async function* kiroSSEToChatSSE(source: ReadableStream<Uint8Array> | null, model: string, parseThinking: boolean): AsyncGenerator<string> {
  const state = newKiroParserState();
  const splitter = new KiroThinkingSplitter(parseThinking);
  const completionID = randomID("chatcmpl");
  let sentRole = false;
  let toolCallCount = 0;
  let activeToolID = "";
  const toolIndex = new Map<string, number>();
  let hasNativeReasoning = false;
  let totalContent = "";
  let outputText = "";
  let contextUsagePercentage = 0;
  let explicitUsage: Record<string, unknown> | null = null;

  const writeChunk = (delta: Record<string, unknown>, finish: unknown, usage: Record<string, unknown> | null): string => {
    const chunk: Record<string, unknown> = { id: completionID, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (usage) chunk["usage"] = usage;
    return "data: " + JSON.stringify(chunk) + "\n\n";
  };
  const ensureRole = (): string => {
    if (!sentRole) {
      sentRole = true;
      return writeChunk({ role: "assistant", content: "" }, null, null);
    }
    return "";
  };
  const emitContent = (contentDelta: string, reasoningDelta: string): string => {
    let out = "";
    if (reasoningDelta !== "") {
      out += ensureRole();
      outputText += reasoningDelta;
      out += writeChunk({ reasoning_content: reasoningDelta }, null, null);
    }
    if (contentDelta !== "") {
      out += ensureRole();
      outputText += contentDelta;
      out += writeChunk({ content: contentDelta }, null, null);
    }
    return out;
  };
  const processEvent = (event: Record<string, unknown>): string => {
    let out = "";
    if ("contextUsagePercentage" in event) {
      contextUsagePercentage = kiroNumberAsFloat(event["contextUsagePercentage"]);
      return out;
    }
    const usage = kiroUsage(event);
    if (usage) {
      explicitUsage = usage;
      return out;
    }
    if (kiroErrorMessage(event) !== "") return out;
    const reasoning = kiroReasoningContent(event);
    if (reasoning !== "") {
      hasNativeReasoning = true;
      out += emitContent("", reasoning);
      return out;
    }
    if (typeof event["content"] === "string" && event["followupPrompt"] === undefined) {
      totalContent += event["content"];
      let [contentDelta, reasoningDelta] = splitter.process(event["content"] as string, false);
      if (hasNativeReasoning && reasoningDelta !== "") reasoningDelta = "";
      out += emitContent(contentDelta, reasoningDelta);
    }
    const name = stringValue(event["name"]);
    const toolUseId = stringValue(event["toolUseId"]);
    if (name !== "" && toolUseId !== "") {
      out += ensureRole();
      let idx = toolIndex.get(toolUseId);
      if (idx === undefined) {
        idx = toolCallCount;
        toolIndex.set(toolUseId, idx);
        toolCallCount++;
      }
      activeToolID = toolUseId;
      out += writeChunk({ tool_calls: [{ index: idx, id: toolUseId, type: "function", function: { name, arguments: "" } }] }, null, null);
      const input = stringValue(event["input"]);
      if (input !== "") {
        out += writeChunk({ tool_calls: [{ index: idx, function: { arguments: input } }] }, null, null);
      }
    }
    const input = stringValue(event["input"]);
    if (input !== "" && stringValue(event["name"]) === "" && activeToolID !== "") {
      const idx = toolIndex.get(activeToolID);
      if (idx !== undefined) {
        out += ensureRole();
        out += writeChunk({ tool_calls: [{ index: idx, function: { arguments: input } }] }, null, null);
      }
    }
    if (event["stop"] === true) {
      activeToolID = "";
    }
    return out;
  };

  // The Go implementation processes raw byte chunks; here we read the full
  // stream once and parse all JSON events in a single pass (semantics preserved).
  const fullText = await readAllText(source);
  const events = parseKiroJSONEvents(fullText, state);
  let out = "";
  for (const event of events) out += processEvent(event);
  yield out;

  const [flushContent, flushReasoning] = splitter.flush();
  if (hasNativeReasoning) {
    yield emitContent(flushContent, "");
  } else {
    yield emitContent(flushContent, flushReasoning);
  }
  for (const call of parseKiroBracketToolCalls(totalContent)) {
    const idx = toolCallCount;
    toolCallCount++;
    yield writeChunk({ tool_calls: [{ index: idx, id: call.ID, type: "function", function: { name: call.Name, arguments: "" } }] }, null, null);
    yield writeChunk({ tool_calls: [{ index: idx, function: { arguments: call.Arguments } }] }, null, null);
  }
  let finish: string = "stop";
  if (toolCallCount > 0) finish = "tool_calls";
  const usage = explicitUsage ?? kiroUsageFromContext(model, contextUsagePercentage, outputText);
  yield writeChunk({}, finish, usage);
  yield "data: [DONE]\n\n";
}

export function convertKiroEventsToCompletion(events: Array<Record<string, unknown>>, model: string, parseThinking: boolean): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  let outputText = "";
  let activeToolID = "";
  let contextUsagePercentage = 0;
  let explicitUsage: Record<string, unknown> | null = null;
  const splitter = new KiroThinkingSplitter(parseThinking);
  let hasNativeReasoning = false;
  type CallState = { index: number; name: string; args: string };
  const toolByID = new Map<string, CallState>();

  for (const event of events) {
    if ("contextUsagePercentage" in event) {
      contextUsagePercentage = kiroNumberAsFloat(event["contextUsagePercentage"]);
    }
    const usage = kiroUsage(event);
    if (usage) explicitUsage = usage;
    if (kiroErrorMessage(event) !== "") continue;
    const reasoningDelta = kiroReasoningContent(event);
    if (reasoningDelta !== "") {
      hasNativeReasoning = true;
      reasoning += reasoningDelta;
      outputText += reasoningDelta;
    }
    if (typeof event["content"] === "string" && event["followupPrompt"] === undefined) {
      let [textDelta, rDelta] = splitter.process(event["content"], false);
      content += textDelta;
      if (!hasNativeReasoning) reasoning += rDelta;
      outputText += textDelta + rDelta;
    }
    const name = stringValue(event["name"]);
    const toolUseId = stringValue(event["toolUseId"]);
    if (name !== "" && toolUseId !== "") {
      activeToolID = toolUseId;
      if (!toolByID.has(toolUseId)) {
        toolByID.set(toolUseId, { index: toolByID.size, name, args: "" });
      }
      const input = stringValue(event["input"]);
      if (input !== "") {
        toolByID.get(toolUseId)!.args += input;
      }
    }
    const input = stringValue(event["input"]);
    if (input !== "" && stringValue(event["name"]) === "" && activeToolID !== "") {
      toolByID.get(activeToolID)!.args += input;
    }
    if (event["stop"] === true) {
      activeToolID = "";
    }
  }
  const [textDelta, reasoningDelta] = splitter.flush();
  content += textDelta;
  if (!hasNativeReasoning) reasoning += reasoningDelta;
  outputText += textDelta + reasoningDelta;

  const toolCalls: unknown[] = new Array(toolByID.size);
  for (const [id, call] of toolByID) {
    toolCalls[call.index] = { id, type: "function", function: { name: call.name, arguments: defaultEmpty(call.args, "{}") } };
  }
  const bracketCalls = parseKiroBracketToolCalls(content);
  if (bracketCalls.length > 0) {
    content = cleanKiroBracketToolCalls(content, bracketCalls);
    for (const call of bracketCalls) {
      toolCalls.push({ id: call.ID, type: "function", function: { name: call.Name, arguments: call.Arguments } });
    }
  }

  const message: Record<string, unknown> = { role: "assistant", content: null };
  if (content !== "") message["content"] = content;
  if (reasoning !== "") message["reasoning_content"] = reasoning;
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  let finish = "stop";
  if (toolCalls.length > 0) finish = "tool_calls";
  const usage = explicitUsage ?? kiroUsageFromContext(model, contextUsagePercentage, outputText);
  return { id: randomID("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage };
}

export function splitKiroSystemMessages(rawMessages: unknown[]): [string, unknown[]] {
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  for (const raw of rawMessages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    if (role === "system" || role === "developer") {
      const text = contentToText(msg["content"]).trim();
      if (text !== "") systemParts.push(text);
      continue;
    }
    messages.push(raw);
  }
  return [systemParts.join("\n\n"), messages];
}

export function normalizeKiroToolMessages(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  let pendingToolResults: unknown[] = [];
  const flushPending = () => {
    if (pendingToolResults.length === 0) return;
    normalized.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    if (role === "tool") {
      pendingToolResults.push({ type: "tool_result", tool_call_id: defaultStringValue(msg["tool_call_id"], randomID("toolu")), content: msg["content"] });
      continue;
    }
    if (role === "assistant") {
      flushPending();
      normalized.push(raw);
      continue;
    }
    if (role === "user") {
      if (pendingToolResults.length > 0) {
        const copyMsg = cloneAnyMap(msg);
        copyMsg["content"] = mergeKiroContent(pendingToolResults, msg["content"]);
        normalized.push(copyMsg);
        pendingToolResults = [];
        continue;
      }
    }
    normalized.push(raw);
  }
  flushPending();
  return normalized;
}

export function mergeAdjacentKiroMessages(messages: unknown[]): unknown[] {
  const merged: unknown[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    if (merged.length > 0 && role !== "tool") {
      const last = (merged[merged.length - 1] ?? {}) as Record<string, unknown>;
      if (stringValue(last["role"]) === role) {
        last["content"] = mergeKiroContent(last["content"], msg["content"]);
        const calls = msg["tool_calls"];
        if (Array.isArray(calls) && calls.length > 0) {
          const existing = (last["tool_calls"] ?? []) as unknown[];
          last["tool_calls"] = [...existing, ...calls];
        }
        continue;
      }
    }
    merged.push(cloneAnyMap(msg));
  }
  return merged;
}

export function mergeKiroContent(a: unknown, b: unknown): unknown {
  const aParts = Array.isArray(a) ? a : null;
  const bParts = Array.isArray(b) ? b : null;
  if (aParts && bParts) return [...aParts, ...bParts];
  if (aParts) {
    const text = stringValue(b);
    if (text !== "") return [...aParts, { type: "text", text }];
    return a;
  }
  if (bParts) {
    const text = stringValue(a);
    if (text !== "") return [{ type: "text", text }, ...bParts];
    return b;
  }
  return joinNonEmpty("\n", contentToText(a), contentToText(b));
}

export function kiroAssistantContentAndToolUses(message: Record<string, unknown>): [string, unknown[]] {
  let content = "";
  let thinking = "";
  const toolUses: unknown[] = [];
  if (Array.isArray(message["content"])) {
    for (const rawPart of message["content"]) {
      const part = (rawPart ?? {}) as Record<string, unknown>;
      switch (stringValue(part["type"])) {
        case "text":
        case "output_text":
          content += contentToText(part);
          break;
        case "thinking":
          thinking += defaultStringValue(part["thinking"], stringValue(part["text"]));
          break;
        case "tool_use": {
          const id = stringValue(part["id"]);
          const name = stringValue(part["name"]);
          if (id !== "" && name !== "") {
            toolUses.push({ toolUseId: id, name, input: defaultAny(part["input"], {}) });
          }
          break;
        }
      }
    }
  } else {
    content = contentToText(message["content"]);
  }
  const calls = message["tool_calls"];
  if (Array.isArray(calls) && calls.length > 0) {
    for (const rawCall of calls) {
      const toolUse = kiroToolUseFromOpenAICall(rawCall);
      if (toolUse) toolUses.push(toolUse);
    }
  }
  if (thinking !== "") {
    const wrapped = kiroThinkingStart + thinking + kiroThinkingEnd;
    content = content !== "" ? wrapped + "\n\n" + content : wrapped;
  }
  return [content, toolUses];
}

export function kiroToolUseFromOpenAICall(rawCall: unknown): Record<string, unknown> | null {
  const call = (rawCall ?? {}) as Record<string, unknown>;
  const fn = (call["function"] ?? {}) as Record<string, unknown>;
  const id = stringValue(call["id"]);
  const name = stringValue(fn["name"]);
  if (id === "" || name === "") return null;
  let input: unknown = {};
  const args = stringValue(fn["arguments"]);
  if (args !== "") {
    try {
      input = JSON.parse(args);
    } catch {
      input = {};
    }
  }
  return { toolUseId: id, name, input };
}

export function kiroToolResultsFromContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const results: unknown[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>;
    if (stringValue(part["type"]) !== "tool_result") continue;
    const id = defaultStringValue(part["tool_use_id"], stringValue(part["tool_call_id"]));
    if (id === "") continue;
    results.push(kiroToolResult(id, contentToText(part["content"])));
  }
  return results;
}

export function reconcileKiroCurrentToolResults(history: unknown[], rawMessages: unknown[], userInput: Record<string, unknown>, modelID: string): void {
  const ctx = (userInput["userInputMessageContext"] ?? {}) as Record<string, unknown>;
  const rawResults = (ctx["toolResults"] ?? []) as unknown[];
  if (rawResults.length === 0) return;
  const historyIDs = kiroHistoryToolUseIDs(history);
  const finalResults: unknown[] = [];
  const orphanedToolUses: unknown[] = [];
  for (const raw of rawResults) {
    const result = (raw ?? {}) as Record<string, unknown>;
    const id = stringValue(result["toolUseId"]);
    if (id === "" || historyIDs[id]) {
      finalResults.push(raw);
      continue;
    }
    const original = findOriginalKiroToolCall(rawMessages, id);
    if (original) {
      orphanedToolUses.push(original);
      finalResults.push(raw);
      historyIDs[id] = true;
      continue;
    }
    userInput["content"] = joinNonEmpty("\n\n", stringValue(userInput["content"]), `[Output for tool call ${id}]:\n${kiroToolResultText(result)}`);
  }
  if (orphanedToolUses.length > 0) {
    if (history.length === 0 || kiroHistoryItemHasAssistant(history[history.length - 1])) {
      history.push({ userInputMessage: { content: "Running tools...", modelId: modelID, origin: "AI_EDITOR" } });
    }
    history.push({ assistantResponseMessage: { content: "I will execute the following tools.", toolUses: orphanedToolUses } });
  }
  setKiroCurrentToolResults(userInput, finalResults);
}

export function setKiroCurrentToolResults(userInput: Record<string, unknown>, results: unknown[]): void {
  let ctx = (userInput["userInputMessageContext"] ?? {}) as Record<string, unknown>;
  if (results.length > 0) {
    ctx["toolResults"] = dedupeKiroToolResults(results);
    userInput["userInputMessageContext"] = ctx;
  } else {
    delete ctx["toolResults"];
    if (Object.keys(ctx).length > 0) {
      userInput["userInputMessageContext"] = ctx;
    } else {
      delete userInput["userInputMessageContext"];
    }
  }
}

export function findOriginalKiroToolCall(messages: unknown[], toolUseID: string): Record<string, unknown> | null {
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    if (stringValue(msg["role"]) !== "assistant") continue;
    const calls = msg["tool_calls"];
    if (Array.isArray(calls)) {
      for (const rawCall of calls) {
        const toolUse = kiroToolUseFromOpenAICall(rawCall);
        if (toolUse && toolUse["toolUseId"] === toolUseID) return toolUse;
      }
    }
    if (Array.isArray(msg["content"])) {
      for (const rawPart of msg["content"]) {
        const part = (rawPart ?? {}) as Record<string, unknown>;
        if (stringValue(part["type"]) === "tool_use" && stringValue(part["id"]) === toolUseID) {
          return { toolUseId: toolUseID, name: stringValue(part["name"]), input: defaultAny(part["input"], {}) };
        }
      }
    }
  }
  return null;
}

export function kiroHistoryToolUseIDs(history: unknown[]): Record<string, boolean> {
  const ids: Record<string, boolean> = {};
  for (const raw of history) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const assistant = (item["assistantResponseMessage"] ?? {}) as Record<string, unknown>;
    const toolUses = (assistant["toolUses"] ?? []) as unknown[];
    for (const rawUse of toolUses) {
      const use = (rawUse ?? {}) as Record<string, unknown>;
      const id = stringValue(use["toolUseId"]);
      if (id !== "") ids[id] = true;
    }
  }
  return ids;
}

export function kiroHistoryItemHasAssistant(raw: unknown): boolean {
  const item = (raw ?? {}) as Record<string, unknown>;
  return "assistantResponseMessage" in item;
}

export function injectKiroSystemPrompt(history: unknown[], systemPrompt: string): boolean {
  for (const raw of history) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const user = (item["userInputMessage"] ?? null) as Record<string, unknown> | null;
    if (!user) continue;
    if (kiroUserInputHasToolResults(user)) continue;
    user["content"] = joinNonEmpty("\n\n", systemPrompt, stringValue(user["content"]));
    return true;
  }
  return false;
}

export function kiroUserInputHasToolResults(userInput: Record<string, unknown>): boolean {
  const ctx = (userInput["userInputMessageContext"] ?? {}) as Record<string, unknown>;
  const results = (ctx["toolResults"] ?? []) as unknown[];
  return results.length > 0;
}

export function sanitizeKiroToolPairing(history: unknown[], currentUser: Record<string, unknown>): unknown[] {
  const sanitized: unknown[] = [];
  let pendingAssistant: Record<string, unknown> | null = null;
  let pendingToolIDs: Record<string, boolean> | null = null;
  for (const raw of history) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const assistant = (item["assistantResponseMessage"] ?? null) as Record<string, unknown> | null;
    if (assistant) {
      filterKiroAssistantToolUses(pendingAssistant, null);
      pendingAssistant = assistant;
      pendingToolIDs = kiroAssistantToolUseIDs(assistant);
      sanitized.push(raw);
      continue;
    }
    const user = (item["userInputMessage"] ?? null) as Record<string, unknown> | null;
    if (user) {
      const resultIDs = sanitizeKiroUserToolResults(user, pendingToolIDs);
      filterKiroAssistantToolUses(pendingAssistant, resultIDs);
      pendingAssistant = null;
      pendingToolIDs = null;
    }
    sanitized.push(raw);
  }
  const currentResultIDs = sanitizeKiroUserToolResults(currentUser, pendingToolIDs);
  filterKiroAssistantToolUses(pendingAssistant, currentResultIDs);
  return sanitized;
}

export function kiroAssistantToolUseIDs(assistant: Record<string, unknown>): Record<string, boolean> | null {
  const uses = (assistant["toolUses"] ?? []) as unknown[];
  if (uses.length === 0) return null;
  const ids: Record<string, boolean> = {};
  for (const rawUse of uses) {
    const use = (rawUse ?? {}) as Record<string, unknown>;
    const id = stringValue(use["toolUseId"]);
    if (id !== "") ids[id] = true;
  }
  return ids;
}

export function sanitizeKiroUserToolResults(user: Record<string, unknown>, allowed: Record<string, boolean> | null): Record<string, boolean> | null {
  const ctx = (user["userInputMessageContext"] ?? {}) as Record<string, unknown>;
  const results = (ctx["toolResults"] ?? []) as unknown[];
  if (results.length === 0) return null;
  if (!allowed || Object.keys(allowed).length === 0) return null;
  const kept: unknown[] = [];
  const keptIDs: Record<string, boolean> = {};
  for (const rawResult of results) {
    const result = (rawResult ?? {}) as Record<string, unknown>;
    const id = stringValue(result["toolUseId"]);
    if (id !== "" && allowed[id]) {
      kept.push(rawResult);
      keptIDs[id] = true;
      continue;
    }
    user["content"] = joinNonEmpty("\n\n", stringValue(user["content"]), `[Output for tool call ${defaultEmpty(id, "unknown")}]:\n${kiroToolResultText(result)}`);
  }
  setKiroCurrentToolResults(user, kept);
  if (Object.keys(keptIDs).length === 0) return null;
  return keptIDs;
}

export function filterKiroAssistantToolUses(assistant: Record<string, unknown> | null, resultIDs: Record<string, boolean> | null): void {
  if (!assistant) return;
  const uses = (assistant["toolUses"] ?? []) as unknown[];
  if (uses.length === 0) return;
  const kept: unknown[] = [];
  for (const rawUse of uses) {
    const use = (rawUse ?? {}) as Record<string, unknown>;
    if (resultIDs && resultIDs[stringValue(use["toolUseId"])]) {
      kept.push(rawUse);
    }
  }
  if (kept.length > 0) {
    assistant["toolUses"] = kept;
    return;
  }
  delete assistant["toolUses"];
}

export function kiroToolResult(id: string, text: string): Record<string, unknown> {
  return { toolUseId: id, status: "success", content: [{ text }] };
}

export function dedupeKiroToolResults(results: unknown[]): unknown[] {
  const seen: Record<string, boolean> = {};
  const out: unknown[] = [];
  for (const raw of results) {
    const result = (raw ?? {}) as Record<string, unknown>;
    const id = stringValue(result["toolUseId"]);
    if (id === "" || seen[id]) continue;
    seen[id] = true;
    out.push(raw);
  }
  return out;
}

export function kiroToolResultText(result: Record<string, unknown>): string {
  return contentToText(result["content"]);
}

function kiroThinkingBudget(body: Record<string, unknown>): number {
  const budget = kiroExplicitThinkingBudget(body);
  if (budget > 0) return budget;
  const effortBudget = defaultThinkingBudget(kiroReasoningEffort(body));
  if (effortBudget > 0) return effortBudget;
  return 20000;
}

function kiroExplicitThinkingBudget(body: Record<string, unknown>): number {
  const budget = numberFromAny(body["thinking_budget"]);
  if (budget > 0) return budget;
  const reasoning = body["reasoning"];
  if (reasoning && typeof reasoning === "object") {
    const r = reasoning as Record<string, unknown>;
    for (const key of ["max_tokens", "budget_tokens", "thinking_budget"]) {
      const value = numberFromAny(r[key]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function kiroReasoningEffort(body: Record<string, unknown>): string {
  const reasoning = body["reasoning"];
  if (reasoning && typeof reasoning === "object") {
    const effort = stringValue((reasoning as Record<string, unknown>)["effort"]);
    if (effort !== "") return effort;
  }
  return stringValue(body["reasoning_effort"]);
}

function kiroIncludeThoughtsFalse(body: Record<string, unknown>): boolean {
  if (typeof body["include_thoughts"] === "boolean" && !body["include_thoughts"]) return true;
  const reasoning = body["reasoning"];
  if (reasoning && typeof reasoning === "object") {
    const include = defaultAny((reasoning as Record<string, unknown>)["include_thoughts"], (reasoning as Record<string, unknown>)["includeThoughts"]);
    if (typeof include === "boolean" && !include) return true;
  }
  return false;
}

export class KiroThinkingSplitter {
  enabled: boolean;
  buffer = "";
  inThinking = false;
  thinkingExtracted = false;
  activeEndTag = "";

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  process(delta: string, final: boolean): [string, string] {
    if (!this.enabled) return [delta, ""];
    this.buffer += delta;
    let content = "";
    let reasoning = "";
    while (this.buffer !== "") {
      if (!this.inThinking && !this.thinkingExtracted) {
        const [start, tag] = findKiroThinkingStartTag(this.buffer);
        if (start >= 0 && tag.end !== "") {
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
        const safeLen = Math.max(0, this.buffer.length - maxKiroThinkingStartLen());
        if (safeLen > 0) {
          content += this.buffer.slice(0, safeLen);
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }
      if (this.inThinking) {
        const endTag = this.activeEndTag !== "" ? this.activeEndTag : kiroThinkingEnd;
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
        const safeLen = Math.max(0, this.buffer.length - endTag.length);
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

function findKiroThinkingStartTag(buffer: string): [number, { start: string; end: string }] {
  let best = -1;
  let bestTag = { start: "", end: "" };
  for (const tag of kiroThinkingTags) {
    const idx = findKiroRealTag(buffer, tag.start);
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
      bestTag = tag;
    }
  }
  return [best, bestTag];
}

function maxKiroThinkingStartLen(): number {
  return Math.max(...kiroThinkingTags.map((t) => t.start.length));
}

function findKiroRealTag(buffer: string, tag: string): number {
  let pos = 0;
  let inCodeBlock = false;
  while (pos < buffer.length) {
    const tagRel = buffer.indexOf(tag, pos);
    if (tagRel === -1) return -1;
    const tagPos = pos + tagRel;
    const fenceRel = buffer.indexOf("```", pos);
    if (fenceRel !== -1 && pos + fenceRel < tagPos) {
      inCodeBlock = !inCodeBlock;
      pos += fenceRel + 3;
      continue;
    }
    if (!inCodeBlock) return tagPos;
    pos = tagPos + tag.length;
  }
  return -1;
}

export interface KiroBracketToolCall {
  ID: string;
  Name: string;
  Arguments: string;
  Raw: string;
}

export function parseKiroBracketToolCalls(text: string): KiroBracketToolCall[] {
  const calls: KiroBracketToolCall[] = [];
  let search = 0;
  while (search < text.length) {
    const startRel = text.indexOf("[Called ", search);
    if (startRel === -1) break;
    const start = search + startRel;
    const nameStart = start + "[Called ".length;
    const marker = text.indexOf(" with args:", nameStart);
    if (marker === -1) {
      search = nameStart;
      continue;
    }
    const name = text.slice(nameStart, marker).trim();
    let argsStart = marker + " with args:".length;
    while (argsStart < text.length && (text[argsStart] === " " || text[argsStart] === "\n" || text[argsStart] === "\t")) argsStart++;
    if (name === "" || argsStart >= text.length || text[argsStart] !== "{") {
      search = argsStart;
      continue;
    }
    const argsEnd = findBalancedJSONEnd(text, argsStart);
    if (argsEnd === -1) break;
    let closeIdx = argsEnd + 1;
    while (closeIdx < text.length && (text[closeIdx] === " " || text[closeIdx] === "\n" || text[closeIdx] === "\t")) closeIdx++;
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
    calls.push({ ID: randomID("toolu"), Name: name, Arguments: args, Raw: text.slice(start, closeIdx + 1) });
    search = closeIdx + 1;
  }
  return calls;
}

export function cleanKiroBracketToolCalls(text: string, calls: KiroBracketToolCall[]): string {
  let cleaned = text;
  for (const call of calls) {
    cleaned = cleaned.split(call.Raw).join("");
  }
  return cleaned.trim().split(/\s+/).join(" ");
}

function findBalancedJSONEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
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
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function kiroUsageFromContext(model: string, contextUsagePercentage: number, outputText: string): Record<string, unknown> {
  const outputTokens = estimateKiroTokens(outputText);
  let inputTokens = 0;
  if (contextUsagePercentage > 0) {
    const totalTokens = Math.round((kiroContextWindowSize(model) * contextUsagePercentage) / 100);
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

function kiroContextWindowSize(model: string): number {
  if (model.includes("-1m")) return 1000000;
  return 200000;
}

function estimateKiroTokens(text: string): number {
  if (text === "") return 0;
  return Math.floor((text.length + 3) / 4);
}

function kiroNumberAsFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function kiroAPIURLForAccount(account: ProviderAccountLike): string {
  let region = kiroDefaultRegion;
  if (account.accountId !== null) {
    const extracted = kiroRegionFromARN(account.accountId);
    if (extracted !== "") region = extracted;
  }
  return kiroAPIBaseURL.replace("%s", region);
}

function kiroRegionFromARN(arn: string): string {
  const parts = arn.trim().split(":");
  if (parts.length >= 4 && parts[0] === "arn" && parts[3] !== "") {
    return parts[3]!;
  }
  return "";
}

export function joinNonEmpty(sep: string, ...values: string[]): string {
  const parts = values.filter((v) => v.trim() !== "");
  return parts.join(sep);
}

function kiroTruncate(value: string, maxLen: number): string {
  if (maxLen <= 0 || value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

function lastModelSegment(model: string): string {
  const idx = model.lastIndexOf("/");
  if (idx >= 0) return model.slice(idx + 1);
  return model;
}

function defaultEmpty(value: string, fallback: string): string {
  return value === "" ? fallback : value;
}

function cloneAnyMap(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = cloneAnyMap(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function defaultThinkingBudget(effort: string): number {
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

async function readAllJSONSafe(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  const text = await readAllText(body);
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
