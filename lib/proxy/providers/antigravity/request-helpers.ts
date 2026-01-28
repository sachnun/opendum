// Request helpers for Antigravity
// Includes system instruction injection and thinking config normalization

import type { RequestPayload, ThinkingConfig } from "./transform/types";
import { getParamType } from "./tool-schema-cache";

const SESSION_ID = `-${Math.floor(Math.random() * 9_000_000_000_000_000)}`;

/**
 * Get session ID (stable per process)
 */
export function getSessionId(): string {
  return SESSION_ID;
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
export const ANTIGRAVITY_BASE_SYSTEM_INSTRUCTION =
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
  const needsInjection =
    normalizedModel.includes("claude") ||
    normalizedModel.includes("gemini-3-pro") ||
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
    { text: ANTIGRAVITY_BASE_SYSTEM_INSTRUCTION },
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
export function processEscapeSequencesOnly(value: unknown): unknown {
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
 * Recursively parses JSON strings nested within objects/arrays.
 */
export function recursivelyParseJsonStrings(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => recursivelyParseJsonStrings(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([key, inner]) => [
        key,
        recursivelyParseJsonStrings(inner),
      ])
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const stripped = value.trim();

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
      // Fall through to other processing.
    }
  }

  if (stripped && (stripped.startsWith("{") || stripped.startsWith("["))) {
    const isWellFormed =
      (stripped.startsWith("{") && stripped.endsWith("}")) ||
      (stripped.startsWith("[") && stripped.endsWith("]"));

    if (isWellFormed) {
      try {
        const parsed = JSON.parse(value);
        return recursivelyParseJsonStrings(parsed);
      } catch {
        // Continue to malformed cases.
      }
    }

    if (stripped.startsWith("[") && !stripped.endsWith("]")) {
      try {
        const lastBracket = stripped.lastIndexOf("]");
        if (lastBracket > 0) {
          const cleaned = stripped.slice(0, lastBracket + 1);
          const parsed = JSON.parse(cleaned);
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Ignore.
      }
    }

    if (stripped.startsWith("{") && !stripped.endsWith("}")) {
      try {
        const lastBrace = stripped.lastIndexOf("}");
        if (lastBrace > 0) {
          const cleaned = stripped.slice(0, lastBrace + 1);
          const parsed = JSON.parse(cleaned);
          return recursivelyParseJsonStrings(parsed);
        }
      } catch {
        // Ignore.
      }
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
  toolName: string
): unknown {
  if (!args || typeof args !== "object") {
    return args;
  }

  const record = args as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const expectedType = getParamType(toolName, key);

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
