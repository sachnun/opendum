import type { Registry } from "@opendum/models/runtime";
import { defaultEmpty, randomId, stringValue } from "#providers/lib/helpers.ts";
import { type Json } from "#providers/providers/kiro/constants.ts";
import { defaultAny, joinNonEmpty, normalizeKiroModel } from "#providers/providers/kiro/helpers.ts";
import {
  convertKiroTools,
  mergeAdjacentKiroMessages,
  normalizeKiroToolMessages,
  splitKiroSystemMessages,
} from "#providers/providers/kiro/messages.ts";
import { kiroThinkingBudget, kiroThinkingRequested } from "#providers/providers/kiro/thinking-request.ts";
import {
  convertKiroMessageToHistoryItem,
  dedupeKiroToolResults,
  kiroToolResultText,
  kiroToolUseFromOpenAICall,
  kiroUserContentAndToolResults,
  kiroUserInputHasToolResults,
} from "#providers/providers/kiro/history-convert.ts";

export {
  convertKiroMessageToHistoryItem,
  dedupeKiroToolResults,
  kiroAssistantContentAndToolUses,
  kiroToolResult,
  kiroToolResultText,
  kiroToolResultsFromContent,
  kiroToolUseFromOpenAICall,
  kiroUserContentAndToolResults,
  kiroUserInputHasToolResults,
} from "#providers/providers/kiro/history-convert.ts";

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
