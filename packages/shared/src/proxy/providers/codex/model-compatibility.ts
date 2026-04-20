const CHATGPT_COMPATIBLE_CODEX_MODELS = new Set([
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
]);

export function isChatGptAccountCompatibleCodexModel(model: string): boolean {
  return CHATGPT_COMPATIBLE_CODEX_MODELS.has(model.trim().toLowerCase());
}

export function getChatGptCompatibleCodexModels(): string[] {
  return [...CHATGPT_COMPATIBLE_CODEX_MODELS].sort((a, b) => a.localeCompare(b));
}
