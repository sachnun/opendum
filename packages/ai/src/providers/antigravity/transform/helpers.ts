import type { RequestPayload } from "./types.js";

export const BASE_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";

export function isImageGenerationModel(model: string): boolean {
  return model.toLowerCase().includes("image");
}

export function applyAntigravitySystemInstruction(
  payload: RequestPayload,
  model: string
): void {
  const normalizedModel = model.toLowerCase();
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

  const basePart = { text: BASE_SYSTEM_INSTRUCTION };

  if (!payload.systemInstruction) {
    payload.systemInstruction = { parts: [basePart] };
  } else if (Array.isArray(payload.systemInstruction.parts)) {
    payload.systemInstruction.parts = [basePart, ...payload.systemInstruction.parts];
  }
}

export function normalizeThinkingConfig(
  payload: RequestPayload,
  model: string,
  thinkingBudget?: number
): void {
  const normalized = model.toLowerCase();
  if (isImageGenerationModel(normalized)) {
    delete payload.generationConfig?.thinkingConfig;
    return;
  }

  if (normalized.includes("gemini-3")) {
    payload.generationConfig ??= {};
    if (thinkingBudget && thinkingBudget > 0) {
      payload.generationConfig.thinkingConfig = {
        thinkingBudget,
      };
    }
  }
}
