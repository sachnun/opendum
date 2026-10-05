import { defaultStringValue, numberFromAny, stringValue } from "#providers/lib/helpers.ts";
import { anySlice, type Json } from "#providers/providers/antigravity/config.ts";
import { defaultThinkingBudget } from "#providers/providers/antigravity/model-config.ts";
import { geminiTools } from "#providers/providers/antigravity/transform.ts";
import {
  completedToolCallIds,
  groupConsecutiveToolResponses,
  openAiContentTextParts,
  openAiContentToGeminiParts,
  openAiToolCallsToGeminiParts,
  sanitizeGeminiContents,
  separateTextAndToolParts,
  toolCallFunctionNameMap,
  toolUseIdSet,
  validToolResultIdSet,
} from "#providers/providers/antigravity/contents-map.ts";

export { inferMimeTypeFromUrl } from "#providers/providers/antigravity/contents-map.ts";

function reasoningEffort(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  return stringValue((value as Json).effort);
}

function requestThinkingConfig(body: Json): Json {
  const config: Json = {};
  const budget = numberFromAny(body.thinking_budget);
  const effort = defaultStringValue(reasoningEffort(body.reasoning), stringValue(body.reasoning_effort));
  if (budget > 0) config.thinkingBudget = budget;
  else if (effort && effort !== "none") {
    const derived = defaultThinkingBudget(effort);
    if (derived > 0) config.thinkingBudget = derived;
  }
  if (Object.keys(config).length > 0 && body.include_thoughts !== undefined) {
    config.include_thoughts = body.include_thoughts;
  }
  return config;
}

export function openAiToGemini(body: Json): Json {
  const messages = anySlice(body.messages);
  let contents: unknown[] = [];
  const systemParts: unknown[] = [];
  const completed = completedToolCallIds(messages);
  const toolUseIds = toolUseIdSet(messages);
  const validToolResultIds = validToolResultIdSet(messages);
  const toolCallFunctionNames = toolCallFunctionNameMap(messages);
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "system" || role === "developer") {
      systemParts.push(...openAiContentTextParts(msg.content));
      continue;
    }
    let parts = openAiContentToGeminiParts(msg.content);
    parts = [...parts, ...openAiToolCallsToGeminiParts(msg, completed)];
    if (role === "tool") {
      const toolCallId = stringValue(msg.tool_call_id);
      if (!toolCallId || !validToolResultIds.has(toolCallId) || !toolUseIds.has(toolCallId)) continue;
      let functionName = stringValue(msg.name);
      if (!functionName) functionName = toolCallFunctionNames[toolCallId] ?? "";
      if (!functionName) functionName = "unknown";
      parts = [
        {
          functionResponse: {
            name: functionName,
            id: toolCallId,
            response: { result: msg.content },
          },
        },
      ];
    }
    const geminiRole = role === "assistant" ? "model" : "user";
    if (parts.length > 0) contents.push({ role: geminiRole, parts });
  }
  contents = separateTextAndToolParts(groupConsecutiveToolResponses(sanitizeGeminiContents(contents)));
  const payload: Json = { contents };
  if (systemParts.length > 0) payload.systemInstruction = { parts: systemParts };
  const generation: Json = {};
  if (body.temperature !== undefined && body.temperature !== null) generation.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) generation.topP = body.top_p;
  if (body.max_tokens !== undefined && body.max_tokens !== null) generation.maxOutputTokens = body.max_tokens;
  if (body.stop !== undefined && body.stop !== null) {
    if (Array.isArray(body.stop)) generation.stopSequences = body.stop;
    else if (stringValue(body.stop)) generation.stopSequences = [body.stop];
  }
  const thinking = requestThinkingConfig(body);
  if (Object.keys(thinking).length > 0) generation.thinkingConfig = thinking;
  if (Object.keys(generation).length > 0) payload.generationConfig = generation;
  const tools = geminiTools(body.tools);
  if (tools.length > 0) payload.tools = [{ functionDeclarations: tools }];
  for (const key of ["cached_content", "cachedContent", "extra_body", "system_instruction"]) {
    if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  payload.safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
  ];
  return payload;
}

