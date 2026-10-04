import { defaultEmpty, randomId, stringValue } from "#providers/lib/helpers.ts";
import { cleanKiroBracketToolCalls, parseKiroBracketToolCalls } from "#providers/providers/kiro/bracket.ts";
import { type Json } from "#providers/providers/kiro/constants.ts";
import {
  kiroErrorMessage,
  kiroNumberAsFloat,
  kiroReasoningContent,
  kiroUsage,
  kiroUsageFromContext,
} from "#providers/providers/kiro/helpers.ts";
import { KiroThinkingSplitter } from "#providers/providers/kiro/thinking.ts";

export {
  KIRO_API_BASE_URL,
  KIRO_THINKING_END,
  KIRO_THINKING_START,
  KIRO_THINKING_TAGS,
  type Json,
} from "#providers/providers/kiro/constants.ts";
export {
  defaultAny,
  defaultThinkingBudget,
  estimateKiroTokens,
  firstKiroNumber,
  joinNonEmpty,
  kiroApiUrlForAccount,
  kiroContextWindowSize,
  kiroErrorMessage,
  kiroNumberAsFloat,
  kiroReasoningContent,
  kiroRegionFromArn,
  kiroTruncate,
  kiroUsage,
  kiroUsageFromContext,
  lastModelSegment,
  normalizeKiroModel,
  normalizeKiroTier,
} from "#providers/providers/kiro/helpers.ts";
export {
  KiroParserState,
  isKiroResponseEvent,
  keepKiroParserTail,
  nextKiroJsonStart,
  normalizeKiroResponseEvents,
  parseKiroJsonEvents,
} from "#providers/providers/kiro/parse.ts";
export {
  KiroThinkingSplitter,
  findKiroRealTag,
  findKiroThinkingStartTag,
  maxKiroThinkingStartLen,
  safeKiroUtf8PrefixLen,
} from "#providers/providers/kiro/thinking.ts";
export {
  type KiroBracketToolCall,
  cleanKiroBracketToolCalls,
  findBalancedJsonEnd,
  parseKiroBracketToolCalls,
} from "#providers/providers/kiro/bracket.ts";
export { kiroExplicitThinkingBudget, kiroIncludeThoughtsFalse, kiroReasoningEffort, kiroThinkingBudget, kiroThinkingRequested } from "#providers/providers/kiro/thinking-request.ts";
export {
  buildKiroRequest,
  convertKiroMessageToHistoryItem,
  dedupeKiroToolResults,
  filterKiroAssistantToolUses,
  findOriginalKiroToolCall,
  injectKiroSystemPrompt,
  kiroAssistantContentAndToolUses,
  kiroAssistantToolUseIds,
  kiroHistoryToolUseIds,
  kiroToolResult,
  kiroToolResultText,
  kiroToolResultsFromContent,
  kiroToolUseFromOpenAICall,
  kiroUserContentAndToolResults,
  kiroUserInputHasToolResults,
  reconcileKiroCurrentToolResults,
  sanitizeKiroToolPairing,
  sanitizeKiroUserToolResults,
  setKiroCurrentToolResults,
} from "#providers/providers/kiro/history.ts";

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
