import type { RequestPayload, ModelFamily } from "./types.js";
import { applyAntigravitySystemInstruction, normalizeThinkingConfig } from "./helpers.js";

export function transformAntigravityRequest(
  payload: RequestPayload,
  model: string,
  _sessionId: string
): RequestPayload {
  const normalized = model.toLowerCase();
  const family: ModelFamily = normalized.includes("claude")
    ? "claude"
    : normalized.includes("flash")
      ? "gemini-flash"
      : "gemini-pro";

  applyAntigravitySystemInstruction(payload, model);
  normalizeThinkingConfig(payload, model);

  return payload;
}
