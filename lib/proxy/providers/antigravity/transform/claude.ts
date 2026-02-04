// Claude transform for Antigravity
// Transforms request payload for Claude proxy models

import { cacheSignature, getCachedSignature } from "../cache";
import {
  applyAntigravitySystemInstruction,
  normalizeThinkingConfig,
} from "../request-helpers";
import { cacheToolSchemas } from "../tool-schema-cache";
import type { RequestPayload, TransformContext, TransformResult } from "./types";

/**
 * Final sanitization for Claude: ensure all functionCall/functionResponse blocks are properly paired.
 * 
 * Claude API requires:
 * 1. Every tool_use (functionCall) must have a corresponding tool_result (functionResponse)
 * 2. Every tool_result must have a corresponding tool_use in the PREVIOUS message
 * 
 * This function removes orphan blocks that would cause Claude to reject the request.
 */
function sanitizeToolBlocksForClaude(
  contents: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (!contents || contents.length === 0) return contents;
  
  // First pass: collect all functionCall IDs and track which have responses
  const functionCallIdToMsgIdx = new Map<string, number>(); // id -> message index where call was made
  const functionResponseIds = new Set<string>(); // IDs of all responses
  
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!parts) continue;
    
    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const id = fc.id as string | undefined;
        if (id) {
          functionCallIdToMsgIdx.set(id, i);
        }
      }
      if (part.functionResponse) {
        const fr = part.functionResponse as Record<string, unknown>;
        const id = fr.id as string | undefined;
        if (id) {
          functionResponseIds.add(id);
        }
      }
    }
  }
  
  // Determine valid pairs:
  // - functionCall is valid if there's a functionResponse with the same ID
  // - functionResponse is valid if there's a functionCall with the same ID in an EARLIER message
  const validFunctionCallIds = new Set<string>();
  const validFunctionResponseIds = new Set<string>();
  
  for (const id of functionCallIdToMsgIdx.keys()) {
    if (functionResponseIds.has(id)) {
      validFunctionCallIds.add(id);
      validFunctionResponseIds.add(id);
    }
  }
  
  // Check for orphan responses (responses without calls)
  for (const responseId of functionResponseIds) {
    if (!functionCallIdToMsgIdx.has(responseId)) {
      // This response has no matching call - it's orphan, don't add to valid set
      // (already not in validFunctionResponseIds since we only add when call exists)
    }
  }
  
  // Second pass: filter contents
  const sanitizedContents: Array<Record<string, unknown>> = [];
  
  for (const content of contents) {
    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!parts) {
      sanitizedContents.push(content);
      continue;
    }
    
    const filteredParts: Array<Record<string, unknown>> = [];
    
    for (const part of parts) {
      if (part.functionCall) {
        const fc = part.functionCall as Record<string, unknown>;
        const id = fc.id as string | undefined;
        if (id && validFunctionCallIds.has(id)) {
          filteredParts.push(part);
        }
        // Skip orphan functionCall (no response)
      } else if (part.functionResponse) {
        const fr = part.functionResponse as Record<string, unknown>;
        const id = fr.id as string | undefined;
        if (id && validFunctionResponseIds.has(id)) {
          filteredParts.push(part);
        }
        // Skip orphan functionResponse (no call)
      } else {
        // Keep non-tool parts
        filteredParts.push(part);
      }
    }
    
    // Only add message if it has parts after filtering
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
 * Transforms a Gemini-format request payload for Claude proxy models.
 *
 * The Antigravity backend routes `gemini-claude-*` models to Claude's API, but
 * Claude expects tool schemas in a different format:
 * - Gemini: `functionDeclarations[].parameters` (or `parametersJsonSchema`)
 * - Claude: `functionDeclarations[].input_schema` with required `type` field
 *
 * Key transformations:
 * 1. Copy `parametersJsonSchema` → `parameters` (AI SDK uses this field)
 * 2. Remove `$schema` from parameters (not valid for Claude)
 * 3. Ensure `type: "object"` and `properties: {}` exist (Claude requires these)
 */
export function transformClaudeRequest(
  context: TransformContext,
  parsedBody: RequestPayload
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };
  let toolsTransformed = false;
  let toolCount = 0;

  delete requestPayload.safetySettings;

  if (!requestPayload.toolConfig) {
    requestPayload.toolConfig = {};
  }
  if (typeof requestPayload.toolConfig === "object") {
    const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
    if (!toolConfig.functionCallingConfig) {
      toolConfig.functionCallingConfig = {};
    }
    if (typeof toolConfig.functionCallingConfig === "object") {
      (toolConfig.functionCallingConfig as Record<string, unknown>).mode =
        "VALIDATED";
    }
  }

  const rawGenerationConfig = requestPayload.generationConfig as
    | Record<string, unknown>
    | undefined;

  let normalizedThinking = normalizeThinkingConfig(
    rawGenerationConfig?.thinkingConfig
  );
  const isThinkingModel = context.model.includes("-thinking");

  if (isThinkingModel) {
    if (!normalizedThinking) {
      normalizedThinking = {
        thinkingBudget: 16384, // Default to 16k for thinking models
        include_thoughts: true,
      };
    } else {
      // If include_thoughts (snake_case) is missing, enable it
      if (normalizedThinking.include_thoughts === undefined) {
        normalizedThinking.include_thoughts = true;
      }

      // Ensure budget is set for thinking models
      if (
        normalizedThinking.thinkingBudget === undefined ||
        normalizedThinking.thinkingBudget === 0
      ) {
        normalizedThinking.thinkingBudget = 16384;
      }
    }

    if (normalizedThinking) {
      // Create a clean config object with verified keys
      // Force snake_case for Antigravity backend to ensure it propagates correctly
      const finalThinkingConfig: Record<string, unknown> = {
        include_thoughts: normalizedThinking.include_thoughts ?? true,
      };

      if (normalizedThinking.thinkingBudget) {
        finalThinkingConfig.thinking_budget = normalizedThinking.thinkingBudget;
      }

      if (rawGenerationConfig) {
        rawGenerationConfig.thinkingConfig = finalThinkingConfig;

        // Apply the maxOutputTokens fix
        const currentMax = (rawGenerationConfig.maxOutputTokens ??
          rawGenerationConfig.max_output_tokens) as number | undefined;
        const budget = normalizedThinking.thinkingBudget;

        if (budget && (!currentMax || currentMax <= budget)) {
          // We use 64k as a safe default for thinking models which usually have higher limits
          const newMax = 64000;
          rawGenerationConfig.maxOutputTokens = newMax;

          if (rawGenerationConfig.max_output_tokens !== undefined) {
            delete rawGenerationConfig.max_output_tokens;
          }
        }

        requestPayload.generationConfig = rawGenerationConfig;
      } else {
        const genConfig: Record<string, unknown> = {
          thinkingConfig: finalThinkingConfig,
        };

        // Apply the maxOutputTokens fix
        const budget = normalizedThinking.thinkingBudget;
        if (budget) {
          genConfig.maxOutputTokens = 64000;
        }

        requestPayload.generationConfig = genConfig;
      }
    } else if (rawGenerationConfig?.thinkingConfig) {
      delete rawGenerationConfig.thinkingConfig;
      requestPayload.generationConfig = rawGenerationConfig;
    }
  } else {
    // Non-thinking models
    if (normalizedThinking) {
      if (rawGenerationConfig) {
        rawGenerationConfig.thinkingConfig = normalizedThinking;
        requestPayload.generationConfig = rawGenerationConfig;
      } else {
        requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
      }
    } else if (rawGenerationConfig?.thinkingConfig) {
      delete rawGenerationConfig.thinkingConfig;
      requestPayload.generationConfig = rawGenerationConfig;
    }
  }

  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }

  applyAntigravitySystemInstruction(requestPayload, context.model);

  const cachedContentFromExtra =
    typeof requestPayload.extra_body === "object" && requestPayload.extra_body
      ? ((requestPayload.extra_body as Record<string, unknown>).cached_content ??
          (requestPayload.extra_body as Record<string, unknown>).cachedContent)
      : undefined;
  const cachedContent =
    (requestPayload.cached_content as string | undefined) ??
    (requestPayload.cachedContent as string | undefined) ??
    (cachedContentFromExtra as string | undefined);
  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }

  delete requestPayload.cached_content;
  delete requestPayload.cachedContent;
  if (
    requestPayload.extra_body &&
    typeof requestPayload.extra_body === "object"
  ) {
    delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
    delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
    if (
      Object.keys(requestPayload.extra_body as Record<string, unknown>)
        .length === 0
    ) {
      delete requestPayload.extra_body;
    }
  }

  if ("model" in requestPayload) {
    delete requestPayload.model;
  }

  // Cache tool schemas for response normalization
  cacheToolSchemas(
    requestPayload.tools as Array<Record<string, unknown>> | undefined
  );

  const tools = requestPayload.tools as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const funcDecls = tool.functionDeclarations as
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(funcDecls)) {
        for (const funcDecl of funcDecls) {
          toolCount++;

          if (funcDecl.parametersJsonSchema) {
            funcDecl.parameters = funcDecl.parametersJsonSchema;
            delete funcDecl.parametersJsonSchema;
            toolsTransformed = true;
          }

          if (
            typeof funcDecl.parameters === "object" &&
            funcDecl.parameters !== null
          ) {
            const params = funcDecl.parameters as Record<string, unknown>;
            delete params["$schema"];

            if (!params.type) {
              params.type = "object";
            }
            if (!params.properties) {
              params.properties = {};
            }
          } else if (!funcDecl.parameters) {
            funcDecl.parameters = { type: "object", properties: {} };
            toolsTransformed = true;
          }
        }
      }
    }
  }

  const contents = requestPayload.contents as
    | Array<Record<string, unknown>>
    | undefined;

  if (Array.isArray(contents)) {
    const funcCallIdQueues = new Map<string, string[]>();

    for (const content of contents) {
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const filteredParts: Array<Record<string, unknown>> = [];

      for (const part of parts) {
        if (part.thought === true) {
          let signature = part.thoughtSignature;

          if (
            !signature ||
            (typeof signature === "string" && signature.length < 50)
          ) {
            if (typeof part.text === "string") {
              const cached = getCachedSignature(
                context.family,
                context.sessionId,
                part.text
              );
              if (cached) {
                signature = cached;
                part.thoughtSignature = cached;
              }
            }
          }

          if (typeof signature === "string" && signature.length > 50) {
            if (typeof part.text === "string" && context.sessionId) {
              cacheSignature(
                context.family,
                context.sessionId,
                part.text,
                signature as string
              );
            }
          } else {
            continue;
          }
        }

        const functionCall = part.functionCall as
          | Record<string, unknown>
          | undefined;
        if (functionCall && typeof functionCall.name === "string") {
          if (!functionCall.id) {
            const callId = `${functionCall.name}-${crypto.randomUUID()}`;
            functionCall.id = callId;
            toolsTransformed = true;
          }
          const queue = funcCallIdQueues.get(functionCall.name) ?? [];
          queue.push(functionCall.id as string);
          funcCallIdQueues.set(functionCall.name, queue);
        }

        const functionResponse = part.functionResponse as
          | Record<string, unknown>
          | undefined;
        if (functionResponse && typeof functionResponse.name === "string") {
          if (!functionResponse.id) {
            const queue = funcCallIdQueues.get(functionResponse.name);
            if (queue && queue.length > 0) {
              functionResponse.id = queue.shift();
            }
          }
        }

        filteredParts.push(part);
      }

      content.parts = filteredParts;
    }
  }

  // Final validation: ensure all text fields in parts are valid strings
  // This prevents Claude API errors like "messages.X.content.Y.text.text: Field required"
  const finalContents = requestPayload.contents as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(finalContents)) {
    for (const content of finalContents) {
      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(parts)) {
        // Filter out invalid parts (text must be a truthy string)
        content.parts = parts.filter((part) => {
          if ("text" in part) {
            // If part has text field, it must be a non-empty string
            return typeof part.text === "string" && part.text.length > 0;
          }
          // Keep non-text parts (functionCall, functionResponse, etc.)
          return true;
        });
      }
    }
    
    // Final sanitization: remove orphan tool blocks
    // This is the last line of defense before sending to Claude API
    requestPayload.contents = sanitizeToolBlocksForClaude(finalContents);
  }

  requestPayload.sessionId = context.sessionId;

  const wrappedBody = {
    project: context.projectId,
    model: context.model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: context.requestId,
    request: requestPayload,
  };

  // Remove thinking config for Claude Sonnet 4.5 (non-thinking fallback)
  if (context.model === "gemini-claude-sonnet-4-5") {
    if (
      requestPayload.generationConfig &&
      (requestPayload.generationConfig as Record<string, unknown>).thinkingConfig
    ) {
      delete (requestPayload.generationConfig as Record<string, unknown>)
        .thinkingConfig;
    }
  }

  return {
    body: JSON.stringify(wrappedBody),
    debugInfo: {
      transformer: "claude",
      toolCount,
      toolsTransformed,
    },
  };
}
