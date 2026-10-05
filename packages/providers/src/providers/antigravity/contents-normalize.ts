import { cloneAnyMap, randomId, stringValue } from "#providers/lib/helpers.ts";
import { anySlice, type Json } from "#providers/providers/antigravity/config.ts";
import { configBool, fallbackAntigravitySystemInstructionModel, normalizeThinkingConfig } from "#providers/providers/antigravity/model-config.ts";
import {
  ensureToolConfig,
  normalizeCachedContent,
  normalizeClaudeTools,
  sanitizeGeminiToolNames,
  sanitizeToolBlocks,
  scrubConversationArtifacts,
  sortFunctionDeclarations,
  stripTrailingModelTurns,
} from "#providers/providers/antigravity/payload.ts";
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, type AntigravityRuntime } from "#providers/providers/antigravity/runtime.ts";
import { cacheSignature, getCachedSignature } from "#providers/providers/antigravity/signature.ts";

export function applyAntigravitySystemInstruction(rt: AntigravityRuntime, payload: Json, model: string): void {
  let needsInjection = configBool(rt, model, "system_instruction");
  if (!needsInjection) {
    if (rt.registry.providerModelConfig(model, rt.name)) return;
    needsInjection = fallbackAntigravitySystemInstructionModel(model);
  }
  if (!needsInjection) return;
  const parts: unknown[] = [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }];
  let existingRecord: Json = {};
  const existing = payload.systemInstruction;
  if (typeof existing === "string" && existing) {
    parts.push({ text: existing });
  } else if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    existingRecord = cloneAnyMap(existing as Json);
    if (Array.isArray((existing as Json).parts)) parts.push(...((existing as Json).parts as unknown[]));
  }
  existingRecord.role = "user";
  existingRecord.parts = parts;
  payload.systemInstruction = existingRecord;
}

export async function normalizeAntigravityContents(
  rt: AntigravityRuntime,
  payload: Json,
  model: string,
  sessionId: string
): Promise<void> {
  const contents = anySlice(payload.contents);
  const strict = configBool(rt, model, "strict_tool_schema");
  const functionCallIdQueues: Record<string, string[]> = {};
  for (const rawContent of contents) {
    const content = rawContent as Json;
    if (configBool(rt, model, "scrub_model_artifacts") && content.role === "model") {
      scrubConversationArtifacts(content);
    }
    const parts = anySlice(content.parts);
    const filtered: unknown[] = [];
    let currentThoughtSignature = "";
    for (const rawPart of parts) {
      const part = rawPart as Json;
      if (typeof part.text === "string" && part.text === "") continue;
      if (part.thought === true) {
        const thoughtText = stringValue(part.text);
        let signature = stringValue(part.thoughtSignature);
        if (strict) {
          if (!signature || signature.length < 50) {
            const cached = await getCachedSignature(rt, model, sessionId, thoughtText);
            if (cached) {
              signature = cached;
              part.thoughtSignature = cached;
            }
          }
          if (signature.length > 50) {
            await cacheSignature(rt, model, sessionId, thoughtText, signature);
            currentThoughtSignature = signature;
          } else {
            continue;
          }
        } else {
          const cached = await getCachedSignature(rt, model, sessionId, thoughtText);
          if (cached) {
            part.thoughtSignature = cached;
            currentThoughtSignature = cached;
            filtered.push(rawPart);
          }
          continue;
        }
      }
      if (part.functionCall !== undefined && part.functionCall !== null) {
        const fn = part.functionCall as Json;
        const name = stringValue(fn.name);
        if (fn.id === undefined || fn.id === null) fn.id = randomId(name);
        if (strict && name) {
          functionCallIdQueues[name] = functionCallIdQueues[name] ?? [];
          functionCallIdQueues[name].push(stringValue(fn.id));
        }
        if (!strict && configBool(rt, model, "inject_thought_signature") && part.thoughtSignature === undefined) {
          part.thoughtSignature = currentThoughtSignature || "skip_thought_signature_validator";
        }
      }
      if (part.functionResponse !== undefined && part.functionResponse !== null) {
        const fn = part.functionResponse as Json;
        if (fn.id === undefined || fn.id === null) {
          const name = stringValue(fn.name);
          if (strict && functionCallIdQueues[name] && functionCallIdQueues[name].length > 0) {
            fn.id = functionCallIdQueues[name].shift();
          } else {
            fn.id = randomId(name);
          }
        }
      }
      if (!strict && part.thoughtSignature !== undefined && part.functionCall === undefined) {
        delete part.thoughtSignature;
      }
      filtered.push(rawPart);
    }
    content.parts = filtered;
  }
  if (strict || configBool(rt, model, "sanitize_tool_blocks")) {
    payload.contents = sanitizeToolBlocks(contents);
    return;
  }
  const kept: unknown[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    if (!content) continue;
    if (anySlice(content.parts).length === 0) continue;
    kept.push(rawContent);
  }
  payload.contents = kept;
}

export async function transformAntigravityPayload(
  rt: AntigravityRuntime,
  payload: Json,
  model: string,
  sessionId: string
): Promise<void> {
  delete payload.safetySettings;
  if (payload.system_instruction !== undefined) {
    payload.systemInstruction = payload.system_instruction;
    delete payload.system_instruction;
  }
  normalizeCachedContent(payload);
  delete payload.model;
  ensureToolConfig(payload);
  normalizeThinkingConfig(rt, payload, model);
  if (configBool(rt, model, "strict_tool_schema")) normalizeClaudeTools(payload);
  else sanitizeGeminiToolNames(payload);
  sortFunctionDeclarations(payload);
  applyAntigravitySystemInstruction(rt, payload, model);
  await normalizeAntigravityContents(rt, payload, model, sessionId);
  stripTrailingModelTurns(payload);
  payload.sessionId = sessionId;
}
