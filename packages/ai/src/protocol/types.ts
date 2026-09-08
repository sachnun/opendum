export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPartType =
  | "text"
  | "image"
  | "thinking"
  | "tool_call"
  | "tool_result";

export interface ImageSource {
  type?: "base64" | "url";
  mediaType?: string;
  data: string;
}

export interface FunctionCall {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: FunctionCall;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ContentPart {
  type: ContentPartType;
  text?: string;
  thinking?: string;
  signature?: string;
  image?: ImageSource;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
}

export interface Message {
  role: Role;
  parts: ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ThinkingConfig {
  enabled: boolean;
  budgetTokens?: number;
  effort?: "low" | "medium" | "high";
}

export interface ToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface CanonicalRequest {
  model: string;
  messages: Message[];
  system?: string;
  stream: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ToolDefinition[];
  toolChoice?: unknown;
  thinking?: ThinkingConfig;
  sessionId?: string;
  extra?: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  thinkingTokens?: number;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  role: Role;
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  stopReason?: string;
  usage: Usage;
  rawProviders?: string[];
}
