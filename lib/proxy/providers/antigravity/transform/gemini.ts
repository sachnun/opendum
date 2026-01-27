// Gemini transform for Antigravity
// Transforms request payload for native Gemini models

import { getCachedSignature } from "../cache";
import {
  applyAntigravitySystemInstruction,
  normalizeThinkingConfig,
  GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION,
} from "../request-helpers";
import type { RequestPayload, TransformContext, TransformResult } from "./types";

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

/**
 * Check if payload has function tools
 */
function hasFunctionTools(payload: RequestPayload): boolean {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => Array.isArray(tool.functionDeclarations));
}

/**
 * Extract system instruction text
 */
function extractSystemInstructionText(systemInstruction: unknown): string {
  if (typeof systemInstruction === "string") {
    return systemInstruction;
  }
  if (!systemInstruction || typeof systemInstruction !== "object") {
    return "";
  }

  const parts = (systemInstruction as Record<string, unknown>).parts as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Inject system instruction for tool schemas if needed
 */
function injectSystemInstructionIfNeeded(payload: RequestPayload): void {
  if (!hasFunctionTools(payload)) return;

  const existingText = extractSystemInstructionText(payload.systemInstruction);
  if (existingText.includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>")) {
    return;
  }

  const existing = payload.systemInstruction;
  if (!existing || typeof existing === "string") {
    const suffix =
      typeof existing === "string" && existing.trim().length > 0
        ? `\n\n${existing}`
        : "";
    payload.systemInstruction = {
      parts: [{ text: `${GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION}${suffix}` }],
    };
    return;
  }

  const asRecord = existing as Record<string, unknown>;
  const parts = asRecord.parts;
  if (Array.isArray(parts)) {
    asRecord.parts = [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }, ...parts];
    payload.systemInstruction = asRecord;
    return;
  }

  payload.systemInstruction = {
    ...asRecord,
    parts: [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }],
  };
}

/**
 * Sanitizes tool names for Gemini API compatibility.
 * Gemini requires tool names to match: ^[a-zA-Z_][a-zA-Z0-9_-]*$
 */
function sanitizeToolNameForGemini(name: string): string {
  if (/^[0-9]/.test(name)) {
    return `t_${name}`;
  }
  return name;
}

/**
 * Recursively sanitizes all tool names in the request payload.
 */
function sanitizeToolNames(payload: RequestPayload): void {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as
      | Array<Record<string, unknown>>
      | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const func of funcDecls) {
      if (typeof func.name === "string") {
        const originalName = func.name;
        func.name = sanitizeToolNameForGemini(originalName);
      }
    }
  }
}

/**
 * Count tools in payload
 */
function countTools(payload: RequestPayload): number {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return 0;
  let count = 0;
  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<unknown> | undefined;
    if (Array.isArray(funcDecls)) {
      count += funcDecls.length;
    }
    if (tool.googleSearch) {
      count += 1;
    }
    if (tool.urlContext) {
      count += 1;
    }
  }
  return count;
}

/**
 * Transforms a request payload for native Gemini models.
 */
export function transformGeminiRequest(
  context: TransformContext,
  parsedBody: RequestPayload
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };

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
  const normalizedThinking = normalizeThinkingConfig(
    rawGenerationConfig?.thinkingConfig
  );
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

  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }

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

  // Sanitize tool names to ensure Gemini API compatibility
  sanitizeToolNames(requestPayload);

  // Inject system instruction for tools if needed
  injectSystemInstructionIfNeeded(requestPayload);

  // Apply Antigravity system instruction
  applyAntigravitySystemInstruction(requestPayload, context.model);

  const contents = requestPayload.contents as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(contents)) {
    for (let contentIndex = 0; contentIndex < contents.length; contentIndex++) {
      const content = contents[contentIndex];
      if (!content) continue;
      if (content.role !== "model") continue;

      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const filteredParts: Array<Record<string, unknown>> = [];
      let currentThoughtSignature: string | undefined;

      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex];
        if (!part) continue;

        if (part.thought === true) {
          const thoughtText = part.text as string | undefined;

          if (thoughtText && context.sessionId) {
            const cachedSig = getCachedSignature(
              context.family,
              context.sessionId,
              thoughtText
            );

            if (cachedSig) {
              part.thoughtSignature = cachedSig;
              currentThoughtSignature = cachedSig;
              filteredParts.push(part);
              continue;
            }
          }

          // Removed thinking block (not in own cache)
          continue;
        }

        if (part.functionCall) {
          const existingSig = part.thoughtSignature;
          if (typeof existingSig !== "string" || existingSig.length === 0) {
            const nextSig = currentThoughtSignature ?? THOUGHT_SIGNATURE_BYPASS;
            part.thoughtSignature = nextSig;
          }

          filteredParts.push(part);
          continue;
        }

        if (part.thoughtSignature !== undefined) {
          delete part.thoughtSignature;
        }

        filteredParts.push(part);
      }

      content.parts = filteredParts;
    }
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

  const toolCount = countTools(requestPayload);

  return {
    body: JSON.stringify(wrappedBody),
    debugInfo: {
      transformer: "gemini",
      toolCount,
    },
  };
}
