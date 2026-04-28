const COMPATIBLE_MODELS = new Set([
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
]);

export function isChatGptAccountCompatibleCodexModel(model: string): boolean {
  return COMPATIBLE_MODELS.has(model.trim().toLowerCase());
}

export function getChatGptCompatibleCodexModels(): string[] {
  return [...COMPATIBLE_MODELS].sort((a, b) => a.localeCompare(b));
}
