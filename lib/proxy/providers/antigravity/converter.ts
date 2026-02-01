// OpenAI <-> Gemini format converter

import type { ChatCompletionRequest } from "../types";
import type { RequestPayload, ModelFamily } from "./transform/types";
import { normalizeToolCallArgs } from "./request-helpers";

/**
 * Effort to budget_tokens mapping for Anthropic/Claude
 * Based on Anthropic docs:
 * - Minimum: 1024 tokens
 * - Recommended starting: low, then increase incrementally
 * - Above 32K: recommend batch processing
 */
const EFFORT_TO_BUDGET: Record<string, number> = {
  none: 0,
  low: 1024,      // Minimum required by Anthropic
  medium: 10000,  // Default value used in Anthropic examples
  high: 32000,    // Maximum before network timeout issues
};

/**
 * Pre-process messages to find tool calls without responses.
 * Claude API requires every tool_use to have a corresponding tool_result.
 * Returns a Set of tool call IDs that have responses.
 * 
 * Handles multiple formats:
 * 1. Standard OpenAI: message with role="tool" and tool_call_id
 * 2. Content array: message with content array containing tool_result blocks
 */
function getCompletedToolCallIds(messages: ChatCompletionRequest["messages"]): Set<string> {
  const toolResponseIds = new Set<string>();
  
  for (const message of messages) {
    // Standard OpenAI format: role="tool"
    if (message.role === "tool" && message.tool_call_id) {
      toolResponseIds.add(message.tool_call_id);
    }
    
    // Alternative format: content array with tool_result blocks (Anthropic style in OpenAI wrapper)
    if (message.role === "user" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          // Handle tool_result block format
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            toolResponseIds.add(b.tool_use_id);
          }
        }
      }
    }
  }
  
  return toolResponseIds;
}

/**
 * Pre-process messages to find all tool call IDs from assistant messages.
 * Used for bidirectional validation - ensures tool_result has matching tool_use.
 * Returns a Set of all tool call IDs from assistant tool_calls.
 */
function getToolUseIds(messages: ChatCompletionRequest["messages"]): Set<string> {
  const toolUseIds = new Set<string>();
  
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const tc = toolCall as { id?: string };
        if (tc.id) {
          toolUseIds.add(tc.id);
        }
      }
    }
  }
  
  return toolUseIds;
}

/**
 * Validate tool sequence: ensure tool_result comes right after tool_use.
 * Returns a Set of valid tool_result IDs (those that have corresponding tool_use in previous assistant message).
 * 
 * This handles the case where context truncation removes a tool_use but keeps the tool_result,
 * which causes Claude API to reject the request.
 * 
 * Handles multiple formats:
 * 1. Standard OpenAI: message with role="tool" and tool_call_id
 * 2. Content array: message with content array containing tool_result blocks
 */
function getValidToolResultIds(messages: ChatCompletionRequest["messages"]): Set<string> {
  const validToolResultIds = new Set<string>();
  let lastAssistantToolCallIds = new Set<string>();
  
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls && Array.isArray(message.tool_calls)) {
      // Collect tool call IDs from this assistant message
      lastAssistantToolCallIds = new Set<string>();
      for (const toolCall of message.tool_calls) {
        const tc = toolCall as { id?: string };
        if (tc.id) {
          lastAssistantToolCallIds.add(tc.id);
        }
      }
    } else if (message.role === "tool" && message.tool_call_id) {
      // Standard format: Check if this tool_result's ID was in the previous assistant's tool_calls
      if (lastAssistantToolCallIds.has(message.tool_call_id)) {
        validToolResultIds.add(message.tool_call_id);
      }
      // Note: Don't clear lastAssistantToolCallIds here - multiple tool results 
      // can follow a single assistant message with multiple tool calls
    } else if (message.role === "user") {
      // Check for tool_result blocks in content array (Anthropic style)
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (typeof block === "object" && block !== null) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
              if (lastAssistantToolCallIds.has(b.tool_use_id)) {
                validToolResultIds.add(b.tool_use_id);
              }
            }
          }
        }
      }
      // Check if this is a real user message (not tool results)
      // Only reset if it's not a tool_result container
      const hasToolResults = Array.isArray(message.content) && 
        message.content.some(b => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "tool_result");
      if (!hasToolResults) {
        lastAssistantToolCallIds = new Set<string>();
      }
    } else if (message.role === "system") {
      // Reset when we see a system message (new context)
      lastAssistantToolCallIds = new Set<string>();
    }
  }
  
  return validToolResultIds;
}

/**
 * Sanitize Gemini-format contents to remove orphan tool calls/responses.
 * 
 * This is the final validation layer after OpenAI->Gemini conversion.
 * It ensures:
 * 1. Every functionCall has a corresponding functionResponse in the next user message
 * 2. Every functionResponse has a corresponding functionCall in the previous model message
 * 3. Empty messages (no valid parts) are removed
 * 
 * This handles edge cases that may slip through the initial filtering,
 * such as when tool calls are in the same message but responses are scattered.
 */
function sanitizeGeminiContents(contents: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (contents.length === 0) return contents;
  
  // First pass: collect all functionCall IDs and their positions
  const functionCallIds = new Map<string, number>(); // id -> message index
  const functionResponseIds = new Map<string, number>(); // id -> message index
  
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!parts) continue;
    
    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const id = fc.id as string | undefined;
        if (id) {
          functionCallIds.set(id, i);
        }
      }
      if (part.functionResponse) {
        const fr = part.functionResponse as Record<string, unknown>;
        const id = fr.id as string | undefined;
        if (id) {
          functionResponseIds.set(id, i);
        }
      }
    }
  }
  
  // Determine which IDs are valid:
  // - functionCall is valid if there's a functionResponse with same ID in a later message
  // - functionResponse is valid if there's a functionCall with same ID in an earlier message
  const validFunctionCallIds = new Set<string>();
  const validFunctionResponseIds = new Set<string>();
  
  for (const [id, callIdx] of functionCallIds) {
    const responseIdx = functionResponseIds.get(id);
    if (responseIdx !== undefined && responseIdx > callIdx) {
      validFunctionCallIds.add(id);
      validFunctionResponseIds.add(id);
    }
  }
  
  // Second pass: filter out invalid parts and empty messages
  const sanitizedContents: Array<Record<string, unknown>> = [];
  
  for (const content of contents) {
    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!parts) continue;
    
    const filteredParts: Array<Record<string, unknown>> = [];
    
    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const id = fc.id as string | undefined;
        if (id && validFunctionCallIds.has(id)) {
          filteredParts.push(part);
        }
        // Skip orphan functionCall
      } else if (part.functionResponse) {
        const fr = part.functionResponse as Record<string, unknown>;
        const id = fr.id as string | undefined;
        if (id && validFunctionResponseIds.has(id)) {
          filteredParts.push(part);
        }
        // Skip orphan functionResponse
      } else {
        // Keep non-tool parts (text, thought, etc.)
        filteredParts.push(part);
      }
    }
    
    // Only add message if it has valid parts
    if (filteredParts.length > 0) {
      sanitizedContents.push({
        ...content,
        parts: filteredParts,
      });
    }
  }
  
  return sanitizedContents;
}

/**
 * Group consecutive tool responses (functionResponse) into a single user message.
 * 
 * Claude API requires that all tool_result blocks corresponding to tool_use blocks
 * in a single assistant message must be in ONE user message immediately after.
 * 
 * Before grouping:
 *   [model] functionCall1, functionCall2
 *   [user] functionResponse1
 *   [user] functionResponse2  ← SEPARATE MESSAGE = ERROR!
 * 
 * After grouping:
 *   [model] functionCall1, functionCall2
 *   [user] functionResponse1, functionResponse2  ← SINGLE MESSAGE = SUCCESS!
 */
function groupConsecutiveToolResponses(
  contents: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (contents.length === 0) return contents;
  
  const grouped: Array<Record<string, unknown>> = [];
  
  for (const content of contents) {
    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!parts) {
      grouped.push(content);
      continue;
    }
    
    // Check if this is a user message with functionResponse parts
    const hasFunctionResponse = parts.some(p => p.functionResponse);
    
    if (content.role === "user" && hasFunctionResponse) {
      // Check if the last message in grouped is also a user message with functionResponse
      const lastGrouped = grouped[grouped.length - 1];
      if (lastGrouped && lastGrouped.role === "user") {
        const lastParts = lastGrouped.parts as Array<Record<string, unknown>> | undefined;
        const lastHasFunctionResponse = lastParts?.some(p => p.functionResponse);
        
        if (lastHasFunctionResponse && lastParts) {
          // Merge parts into the previous message
          lastParts.push(...parts);
          continue;
        }
      }
    }
    
    // Create a new entry with copied parts array (to avoid mutation issues)
    grouped.push({
      ...content,
      parts: [...parts],
    });
  }
  
  return grouped;
}

/**
 * Separate text and functionCall parts in model messages.
 * 
 * Claude API may require that model messages with functionCall blocks
 * don't have text content mixed in. This function splits such messages.
 * 
 * Also removes text parts from user messages that have functionResponse.
 * 
 * Before:
 *   [model] text, functionCall1, functionCall2
 * 
 * After:
 *   [model] text
 *   [model] functionCall1, functionCall2
 */
function separateTextAndToolParts(
  contents: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (contents.length === 0) return contents;
  
  const result: Array<Record<string, unknown>> = [];
  
  for (const content of contents) {
    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!parts || parts.length === 0) {
      result.push(content);
      continue;
    }
    
    const textParts = parts.filter(p => 
      p.text !== undefined && !p.thought && !p.functionCall && !p.functionResponse
    );
    const thoughtParts = parts.filter(p => p.thought === true);
    const functionCallParts = parts.filter(p => p.functionCall);
    const functionResponseParts = parts.filter(p => p.functionResponse);
    const otherParts = parts.filter(p => 
      !p.text && !p.thought && !p.functionCall && !p.functionResponse
    );
    
    if (content.role === "model") {
      // For model messages: separate text/thought from functionCall
      const hasFunctionCalls = functionCallParts.length > 0;
      const hasTextOrThought = textParts.length > 0 || thoughtParts.length > 0;
      
      if (hasFunctionCalls && hasTextOrThought) {
        // Split into two messages: text/thought first, then functionCalls
        const textAndThoughtParts = [...thoughtParts, ...textParts, ...otherParts];
        if (textAndThoughtParts.length > 0) {
          result.push({
            ...content,
            parts: textAndThoughtParts,
          });
        }
        
        if (functionCallParts.length > 0) {
          result.push({
            ...content,
            parts: functionCallParts,
          });
        }
      } else {
        // No need to split - keep as is
        result.push(content);
      }
    } else if (content.role === "user") {
      // For user messages with functionResponse: remove text parts
      const hasFunctionResponses = functionResponseParts.length > 0;
      
      if (hasFunctionResponses) {
        // Only keep functionResponse parts (and maybe other non-text parts)
        const cleanParts = [...functionResponseParts, ...otherParts];
        if (cleanParts.length > 0) {
          result.push({
            ...content,
            parts: cleanParts,
          });
        }
      } else {
        // No functionResponse - keep as is
        result.push(content);
      }
    } else {
      // Other roles - keep as is
      result.push(content);
    }
  }
  
  return result;
}

/**
 * Convert OpenAI messages to Gemini format
 */
export function convertOpenAIToGemini(
  request: ChatCompletionRequest
): RequestPayload {
  const contents: Array<Record<string, unknown>> = [];
  let systemInstruction: unknown = undefined;
  
  // Bidirectional validation:
  // 1. completedToolCallIds: tool_call IDs that have tool_result responses
  // 2. toolUseIds: all tool_call IDs from assistant messages  
  // 3. validToolResultIds: tool_result IDs that have matching tool_use in previous message
  const completedToolCallIds = getCompletedToolCallIds(request.messages);
  const toolUseIds = getToolUseIds(request.messages);
  const validToolResultIds = getValidToolResultIds(request.messages);

  for (const message of request.messages) {
    if (message.role === "system") {
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((c) => c.type === "text")
                .map((c) => (c as { text?: string }).text ?? "")
                .join("\n")
            : "";

      if (systemInstruction) {
        const existing = systemInstruction as { parts: Array<{ text: string }> };
        existing.parts.push({ text });
      } else {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];

    if (typeof message.content === "string") {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const content of message.content) {
        if (content.type === "text") {
          const textContent = (content as { text?: string }).text;
          if (textContent) {
            parts.push({ text: textContent });
          }
        } else if (content.type === "image_url") {
          const imageUrl = (content as { image_url?: { url?: string } }).image_url;
          if (imageUrl?.url) {
            if (imageUrl.url.startsWith("data:")) {
              const match = imageUrl.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                parts.push({
                  inlineData: {
                    mimeType: match[1],
                    data: match[2],
                  },
                });
              }
            } else {
              parts.push({
                fileData: {
                  fileUri: imageUrl.url,
                },
              });
            }
          }
        }
      }
    }

    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const tc = toolCall as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        
        // Filter: skip tool_use that doesn't have a matching tool_result
        if (tc.id && !completedToolCallIds.has(tc.id)) {
          continue;
        }
        
        if (tc.function) {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments ?? "{}");
          } catch {
            args = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
              id: tc.id,
            },
          });
        }
      }
    }

    if (message.role === "tool" && message.tool_call_id) {
      // Skip orphan tool_result: must have matching tool_use in previous assistant message
      // AND the tool_use must still exist (not filtered out due to missing response)
      if (!validToolResultIds.has(message.tool_call_id)) {
        // This tool_result doesn't have a matching tool_use in the expected position
        continue;
      }
      if (!toolUseIds.has(message.tool_call_id)) {
        // The corresponding tool_use was removed (likely due to missing response)
        continue;
      }
      
      parts.push({
        functionResponse: {
          name: message.name ?? "unknown",
          id: message.tool_call_id,
          response: {
            result: message.content,
          },
        },
      });
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  // Final sanitization: remove any remaining orphan tool calls/responses
  // This catches edge cases that may slip through the initial filtering
  const sanitizedContents = sanitizeGeminiContents(contents);
  
  // Group consecutive tool responses into single user messages
  // Claude API requires all tool_result blocks for a batch of tool_use blocks
  // to be in ONE user message immediately after the assistant message
  const groupedContents = groupConsecutiveToolResponses(sanitizedContents);
  
  // Separate text and functionCall parts in model messages
  // Claude API requires functionCall to be in dedicated messages without text mixing
  // Also removes text parts from user messages with functionResponse
  const finalContents = separateTextAndToolParts(groupedContents);

  const payload: RequestPayload = {
    contents: finalContents,
  };

  if (systemInstruction) {
    payload.systemInstruction = systemInstruction;
  }

  const generationConfig: Record<string, unknown> = {};

  if (request.temperature !== undefined) {
    generationConfig.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    generationConfig.topP = request.top_p;
  }
  if (request.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = request.max_tokens;
  }
  if (request.stop) {
    generationConfig.stopSequences = Array.isArray(request.stop)
      ? request.stop
      : [request.stop];
  }

  const reasoningEffort = request.reasoning?.effort || request.reasoning_effort;
  const thinkingBudget = request.thinking_budget;
  
  if (reasoningEffort || thinkingBudget) {
    const thinkingConfig: Record<string, unknown> = {};

    if (thinkingBudget) {
      thinkingConfig.thinkingBudget = thinkingBudget;
    } else if (reasoningEffort && reasoningEffort !== "none") {
      const budget = EFFORT_TO_BUDGET[reasoningEffort];
      if (budget && budget > 0) {
        thinkingConfig.thinkingBudget = budget;
      }
    }

    if (request.include_thoughts !== undefined) {
      thinkingConfig.include_thoughts = request.include_thoughts;
    }

    if (Object.keys(thinkingConfig).length > 0) {
      generationConfig.thinkingConfig = thinkingConfig;
    }
  }

  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  if (request.tools && request.tools.length > 0) {
    const functionDeclarations = request.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));

    if (functionDeclarations.length > 0) {
      payload.tools = [{ functionDeclarations }];
    }
  }

  return payload;
}

/**
 * Determine model family from model name
 */
export function getModelFamily(model: string): ModelFamily {
  return model.includes("claude")
    ? "claude"
    : model.includes("flash")
      ? "gemini-flash"
      : "gemini-pro";
}

/**
 * Convert Gemini response to OpenAI format (non-streaming)
 * @param geminiResponse - Raw Gemini response
 * @param model - Model name for response
 * @param includeReasoning - Whether to include reasoning_content in response (default: true)
 */
export function convertGeminiToOpenAI(
  geminiResponse: Record<string, unknown>,
  model: string,
  includeReasoning: boolean = true
): Record<string, unknown> {
  const candidates = geminiResponse.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  const usageMetadata = geminiResponse.usageMetadata as
    | Record<string, unknown>
    | undefined;

  const choices: Array<Record<string, unknown>> = [];

  if (candidates && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const content = candidate.content as Record<string, unknown> | undefined;
      const parts = content?.parts as Array<Record<string, unknown>> | undefined;

      let textContent = "";
      const toolCalls: Array<Record<string, unknown>> = [];
      let reasoningContent = "";

      if (parts) {
        for (const part of parts) {
          if (part.thought === true && typeof part.text === "string") {
            reasoningContent += part.text;
          } else if (typeof part.text === "string") {
            textContent += part.text;
          } else if (part.functionCall) {
            const fc = part.functionCall as Record<string, unknown>;
            const funcName = fc.name as string;
            const normalizedArgs = normalizeToolCallArgs(fc.args ?? {}, funcName);
            toolCalls.push({
              id: fc.id ?? `call_${crypto.randomUUID()}`,
              type: "function",
              function: {
                name: funcName,
                arguments: JSON.stringify(normalizedArgs),
              },
            });
          }
        }
      }

      const message: Record<string, unknown> = {
        role: "assistant",
        content: textContent || null,
      };

      if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    if (reasoningContent && includeReasoning) {
        message.reasoning_content = reasoningContent;
      }

      const finishReason = candidate.finishReason as string | undefined;
      let openaiFinishReason = "stop";
      if (finishReason === "STOP") {
        openaiFinishReason = "stop";
      } else if (finishReason === "MAX_TOKENS") {
        openaiFinishReason = "length";
      } else if (finishReason === "TOOL_CALLS" || toolCalls.length > 0) {
        openaiFinishReason = "tool_calls";
      }

      choices.push({
        index: i,
        message,
        finish_reason: openaiFinishReason,
      });
    }
  }

  const usage: Record<string, unknown> = {
    prompt_tokens: usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: usageMetadata?.totalTokenCount ?? 0,
  };

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage,
  };
}

/**
 * Create SSE transform stream for converting Gemini SSE to OpenAI SSE format
 *
 * State tracking for proper OpenAI streaming format:
 * - isFirstChunk: Ensures 'role: assistant' is sent on first delta
 * - toolCallIndex: Tracks index for multiple tool calls (0, 1, 2...)
 * - hasToolCalls: Determines if finish_reason should be 'tool_calls'
 * - toolCallIds: Stores stable IDs per tool call name within this request
 * - completionId: Single ID for entire completion (not per-chunk)
 * 
 * @param model - Model name for response
 * @param includeReasoning - Whether to include reasoning_content in response (default: true)
 */
export function createGeminiToOpenAISseTransform(
  model: string,
  includeReasoning: boolean = true
): TransformStream<string, string> {
  let isFirstChunk = true;
  let toolCallIndex = 0;
  let hasToolCalls = false;
  const toolCallIds = new Map<string, string>();
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  
  let trackedUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null = null;

  return new TransformStream<string, string>({
    transform(line, controller) {
      if (!line.startsWith("data:")) {
        controller.enqueue(line);
        return;
      }

      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") {
        controller.enqueue(line);
        return;
      }

      try {
        const geminiChunk = JSON.parse(json) as Record<string, unknown>;
        
        const usageMetadata = geminiChunk.usageMetadata as Record<string, unknown> | undefined;
        if (usageMetadata) {
          trackedUsage = {
            prompt_tokens: (usageMetadata.promptTokenCount as number) ?? 0,
            completion_tokens: (usageMetadata.candidatesTokenCount as number) ?? 0,
            total_tokens: (usageMetadata.totalTokenCount as number) ?? 0,
          };
        }
        
        const candidates = geminiChunk.candidates as
          | Array<Record<string, unknown>>
          | undefined;

        if (!candidates || candidates.length === 0) {
          return;
        }

        const candidate = candidates[0];
        const content = candidate.content as Record<string, unknown> | undefined;
        const parts = content?.parts as Array<Record<string, unknown>> | undefined;

        if (!parts || parts.length === 0) {
          const candidateFinishReason = candidate.finishReason as string | undefined;
          if (candidateFinishReason) {
            let openaiFinishReason = "stop";
            if (candidateFinishReason === "MAX_TOKENS") {
              openaiFinishReason = "length";
            } else if (hasToolCalls) {
              openaiFinishReason = "tool_calls";
            }

            const finalChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: openaiFinishReason,
                },
              ],
            };

            controller.enqueue(`data: ${JSON.stringify(finalChunk)}\n\n`);
          }
          return;
        }

        for (const part of parts) {
          const delta: Record<string, unknown> = {};

          if (part.thought === true && typeof part.text === "string") {
            if (!includeReasoning) {
              continue;
            }
            if (isFirstChunk) {
              delta.role = "assistant";
              isFirstChunk = false;
            }
            delta.reasoning_content = part.text;
          } else if (typeof part.text === "string") {
            if (isFirstChunk) {
              delta.role = "assistant";
              isFirstChunk = false;
            }
            delta.content = part.text;
          } else if (part.functionCall) {
            const fc = part.functionCall as Record<string, unknown>;
            const funcName = fc.name as string;

            let toolId = fc.id as string | undefined;
            if (!toolId) {
              toolId = toolCallIds.get(funcName);
              if (!toolId) {
                toolId = `call_${crypto.randomUUID()}`;
                toolCallIds.set(funcName, toolId);
              }
            }

            if (isFirstChunk) {
              delta.role = "assistant";
              isFirstChunk = false;
            }

            const normalizedArgs = normalizeToolCallArgs(fc.args ?? {}, funcName);

            delta.tool_calls = [
              {
                index: toolCallIndex,
                id: toolId,
                type: "function",
                function: {
                  name: funcName,
                  arguments: JSON.stringify(normalizedArgs),
                },
              },
            ];

            toolCallIndex++;
            hasToolCalls = true;
          }

          if (Object.keys(delta).length === 0) {
            continue;
          }

          const openaiChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: null,
              },
            ],
          };

          controller.enqueue(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        }

        const candidateFinishReason = candidate.finishReason as string | undefined;
        if (candidateFinishReason) {
          let openaiFinishReason = "stop";
          if (candidateFinishReason === "MAX_TOKENS") {
            openaiFinishReason = "length";
          } else if (hasToolCalls) {
            openaiFinishReason = "tool_calls";
          }

          const finalChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: openaiFinishReason,
              },
            ],
          };

          controller.enqueue(`data: ${JSON.stringify(finalChunk)}\n\n`);
        }
      } catch {
        // Skip malformed chunks
      }
    },
    flush(controller) {
      // Emit final chunk with usage data if we tracked any
      if (trackedUsage) {
        const usageChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: null,
            },
          ],
          usage: trackedUsage,
        };
        controller.enqueue(`data: ${JSON.stringify(usageChunk)}\n\n`);
      }
      controller.enqueue("data: [DONE]\n\n");
    },
  });
}

/**
 * Create SSE transform stream that unwraps Antigravity response wrapper
 */
export function createAntigravityUnwrapTransform(): TransformStream<
  string,
  string
> {
  let buffer = "";

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          controller.enqueue(line + "\n\n");
          continue;
        }

        const json = line.slice(5).trim();
        if (!json) {
          controller.enqueue(line + "\n\n");
          continue;
        }

        try {
          let parsed = JSON.parse(json) as unknown;

          if (Array.isArray(parsed)) {
            parsed = parsed.find((item) => typeof item === "object" && item !== null);
          }

          if (!parsed || typeof parsed !== "object") {
            controller.enqueue(line + "\n\n");
            continue;
          }

          const body = parsed as Record<string, unknown>;

          if (body.response !== undefined) {
            controller.enqueue(`data: ${JSON.stringify(body.response)}\n\n`);
          } else {
            controller.enqueue(line + "\n\n");
          }
        } catch {
          controller.enqueue(line + "\n\n");
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(buffer);
      }
    },
  });
}
