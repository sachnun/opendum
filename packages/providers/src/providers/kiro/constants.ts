export const KIRO_API_BASE_URL = "https://q.%s.amazonaws.com/generateAssistantResponse";
export const KIRO_THINKING_START = "<thinking>";
export const KIRO_THINKING_END = "</thinking>";

export const KIRO_THINKING_TAGS = [
  { start: "<thinking>", end: "</thinking>" },
  { start: "<think>", end: "</think>" },
  { start: "<reasoning>", end: "</reasoning>" },
  { start: "<thought>", end: "</thought>" },
];

export type Json = Record<string, unknown>;
