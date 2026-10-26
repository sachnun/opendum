export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type PlaygroundEndpoint = "chat_completions" | "messages" | "responses";

export type ScenarioMessage = { role: string; content: string | Array<Record<string, unknown>> };

export type ParsedUsageData = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type ToolCallData = { name: string; arguments: string };

export type ParsedCompletionData = {
  content: string;
  reasoning: string;
  toolCalls: ToolCallData[];
  usage: ParsedUsageData | null;
};

export type ResponseMetrics = {
  waitMs: number | null;
  firstResponseMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export interface PlaygroundSettings {
  endpoint: PlaygroundEndpoint;
  streamResponses: boolean;
  temperature: number;
  topP: number;
  maxTokens: number;
  presencePenalty: number;
  frequencyPenalty: number;
  reasoningEffort: ReasoningEffort;
}

export const ERROR_STRING_LIMIT = 200;

export const ARRAY_PREVIEW_LIMIT = 10;

export const ERROR_MESSAGE_LIMIT = 30;

export const RAW_MESSAGE_LIMIT = 2000;
