// Request helpers for Antigravity
// Includes system instruction injection and thinking config normalization

import type { RequestPayload, ThinkingConfig } from "./transform/types.js";
import { getParamType, type ToolSchemaMap } from "./tool-schema.js";

/**
 * Check if a model is an image generation model (e.g. Nano Banana / Nano Banana Pro).
 * Image generation models have fundamentally different capabilities:
 * - No tool/function calling support
 * - No reasoning/thinking support
 * - Should NOT receive the Antigravity coding system instruction
 * - Should NOT receive toolConfig/functionCallingConfig
 */
export function isImageGenerationModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.includes("image");
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `agent-${crypto.randomUUID()}`;
}

/**
 * Base Antigravity system instruction - required by the API
 */
const BASE_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

/**
 * Applies the Antigravity system instruction to the request payload.
 *
 * Logic (matching reference implementation):
 * - ALWAYS prepend Antigravity prompt as parts[0]
 * - User's existing system prompt comes after (parts[1+])
 *
 * The Antigravity API requires this system prompt structure to function.
 */
export function applyAntigravitySystemInstruction(
  payload: RequestPayload,
  model: string
): void {
  const normalizedModel = model.toLowerCase();

  // Image generation models should NOT receive the coding system instruction
  if (isImageGenerationModel(normalizedModel)) {
    return;
  }

  const needsInjection =
    normalizedModel.includes("claude") ||
    normalizedModel.includes("gemini-3-pro") ||
    normalizedModel.includes("gemini-3.1-pro") ||
    normalizedModel.includes("gemini-3-flash");

  if (!needsInjection) {
    return;
  }

  const existing = payload.systemInstruction;
  let existingParts: Array<Record<string, unknown>> = [];
  let existingRecord: Record<string, unknown> | undefined;

  if (typeof existing === "string") {
    if (existing.length > 0) {
      existingParts = [{ text: existing }];
    }
  } else if (existing && typeof existing === "object") {
    existingRecord = existing as Record<string, unknown>;
    const parts = existingRecord.parts;
    if (Array.isArray(parts)) {
      existingParts = parts.filter(
        (part): part is Record<string, unknown> =>
          typeof part === "object" && part !== null
      );
    }
  }

  const nextParts = [
    { text: BASE_SYSTEM_INSTRUCTION },
    ...existingParts,
  ];

  payload.systemInstruction = existingRecord
    ? { ...existingRecord, role: "user", parts: nextParts }
    : { role: "user", parts: nextParts };
}

/**
 * Normalizes thinkingConfig - passes through values as-is without mapping.
 */
export function normalizeThinkingConfig(
  config: unknown
): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget =
    typeof budgetRaw === "number" && Number.isFinite(budgetRaw)
      ? budgetRaw
      : undefined;
  const thinkingLevel =
    typeof levelRaw === "string" && levelRaw.length > 0
      ? levelRaw.toLowerCase()
      : undefined;
  const includeThoughts =
    typeof includeRaw === "boolean" ? includeRaw : undefined;

  if (
    thinkingBudget === undefined &&
    thinkingLevel === undefined &&
    includeThoughts === undefined
  ) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== undefined) {
    normalized.thinkingLevel = thinkingLevel;
  }
  if (includeThoughts !== undefined) {
    normalized.include_thoughts = includeThoughts;
  }
  return normalized;
}

/**
 * Processes a value by only unescaping control characters (like \n, \t).
 * It does NOT attempt to parse JSON objects from strings.
 */
function processEscapeSequencesOnly(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const hasControlCharEscapes =
    value.includes("\\n") || value.includes("\\t");
  const hasIntentionalEscapes =
    value.includes('\\"') || value.includes("\\\\");

  if (hasControlCharEscapes && !hasIntentionalEscapes) {
    try {
      const unescaped = JSON.parse(`"${value.replaceAll('"', '\\"')}"`);
      if (typeof unescaped === "string") {
        return unescaped;
      }
    } catch {
      // Fall back to original
    }
  }

  return value;
}

/**
 * Normalizes tool call arguments based on their schema.
 * - If schema says string: only unescape control characters, don't parse as JSON.
 * - If schema says array/object: attempt to parse string as JSON.
 * - If no schema: fallback to processEscapeSequencesOnly.
 */
export function normalizeToolCallArgs(
  args: unknown,
  toolName: string,
  toolSchemas?: ToolSchemaMap
): unknown {
  if (!args || typeof args !== "object") {
    return args;
  }

  const record = args as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const expectedType = getParamType(toolSchemas, toolName, key);

    if (expectedType === "string") {
      result[key] = processEscapeSequencesOnly(value);
    } else if (
      typeof value === "string" &&
      (expectedType === "array" || expectedType === "object")
    ) {
      // If we expect an array/object but got a string, try to parse it
      try {
        const parsed = JSON.parse(value);
        result[key] = parsed;
      } catch {
        result[key] = processEscapeSequencesOnly(value);
      }
    } else if (expectedType === undefined) {
      // No schema info: be conservative and only unescape control characters
      result[key] = processEscapeSequencesOnly(value);
    } else {
      // For other types, or if it's already an object, just process escapes
      result[key] = processEscapeSequencesOnly(value);
    }
  }

  return result;
}
