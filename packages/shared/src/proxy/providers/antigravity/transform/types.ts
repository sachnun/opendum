// Transform types for Antigravity

export type ModelFamily = "claude" | "gemini-flash" | "gemini-pro";

export interface TransformContext {
  model: string;
  family: ModelFamily;
  projectId: string;
  streaming: boolean;
  requestId: string;
  sessionId: string;
}

export interface TransformResult {
  body: string;
  debugInfo: {
    transformer: string;
    toolCount?: number;
    toolsTransformed?: boolean;
  };
}

export interface RequestPayload {
  contents?: unknown[];
  generationConfig?: unknown;
  systemInstruction?: unknown;
  system_instruction?: unknown;
  tools?: unknown[];
  toolConfig?: unknown;
  safetySettings?: unknown;
  model?: string;
  cached_content?: string;
  cachedContent?: string;
  extra_body?: unknown;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
  include_thoughts?: boolean;
}
