export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";

export interface ToolSchemaMap {
  [toolName: string]: {
    type?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface RequestPayload {
  contents?: unknown[];
  generationConfig?: Record<string, unknown>;
  systemInstruction?: Record<string, unknown>;
  system_instruction?: Record<string, unknown>;
  tools?: unknown[];
  toolConfig?: unknown;
  safetySettings?: unknown;
  model?: string;
  cachedContent?: string;
  sessionId?: string;
  [key: string]: unknown;
}
