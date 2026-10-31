import { Schema } from "effect";

export type IrText = { type: "text"; text: string; cache?: boolean };

export type IrImage =
  | { type: "image"; source: "url"; url: string; detail?: "auto" | "low" | "high" }
  | { type: "image"; source: "base64"; mediaType: string; data: string; detail?: "auto" | "low" | "high" };

export type IrToolCall = { type: "tool_call"; id: string; name: string; arguments: string };

export type IrToolResult = {
  type: "tool_result";
  toolCallId: string;
  content: Array<IrText | IrImage>;
  isError?: boolean;
};

export type IrReasoning = {
  type: "reasoning";
  text: string;
  signature?: string;
  redacted?: string;
};

export type IrContent = IrText | IrImage | IrToolCall | IrToolResult | IrReasoning;

export type IrRole = "system" | "user" | "assistant" | "tool";

export type IrMessage = { role: IrRole; content: IrContent[] };

export type IrTool = {
  name: string;
  description?: string;
  parameters: unknown;
  strict?: boolean;
  cache?: boolean;
};

export type IrToolChoice = "auto" | "none" | "required" | { name: string };

export type IrReasoningConfig = {
  mode: "off" | "effort" | "budget";
  effort?: string;
  budget?: number;
  summary?: boolean;
  signature?: boolean;
};

export type IrSampling = {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

export type IrRequest = {
  model: string;
  messages: IrMessage[];
  tools: IrTool[];
  toolChoice?: IrToolChoice;
  parallelToolCalls?: boolean;
  sampling: IrSampling;
  reasoning?: IrReasoningConfig;
  stream: boolean;
  responseFormat?: unknown;
  previousResponseId?: string;
  user?: string;
  metadata: Record<string, string>;
};

export type IrUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

export type IrFinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "refusal" | "pause";

export type IrError = { message: string; type: string; code?: string };

export type IrResponseStatus = "completed" | "incomplete" | "failed";

export type IrResponse = {
  id: string;
  model: string;
  content: IrContent[];
  finishReason: IrFinishReason;
  usage: IrUsage;
  status: IrResponseStatus;
  incompleteReason?: string;
};

export type IrEventStart = { type: "start"; id: string; model: string };
export type IrEventReasoning = { type: "reasoning_delta"; text: string; signature?: string };
export type IrEventText = { type: "text_delta"; text: string };
export type IrEventToolStart = { type: "tool_start"; index: number; id: string; name: string };
export type IrEventToolArgs = { type: "tool_args_delta"; index: number; json: string };
export type IrEventFinish = { type: "finish"; reason: IrFinishReason; usage: IrUsage };
export type IrEventError = { type: "error"; error: IrError };

export type IrEvent =
  | IrEventStart
  | IrEventReasoning
  | IrEventText
  | IrEventToolStart
  | IrEventToolArgs
  | IrEventFinish
  | IrEventError;

const IrTextSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache: Schema.optional(Schema.Boolean),
});

const IrImageUrlSchema = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Literal("url"),
  url: Schema.String,
  detail: Schema.optional(Schema.Literals(["auto", "low", "high"])),
});

const IrImageBase64Schema = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Literal("base64"),
  mediaType: Schema.String,
  data: Schema.String,
  detail: Schema.optional(Schema.Literals(["auto", "low", "high"])),
});

const IrImageSchema = Schema.Union([IrImageUrlSchema, IrImageBase64Schema]);

const IrToolCallSchema = Schema.Struct({
  type: Schema.Literal("tool_call"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});

const IrToolResultSchema = Schema.Struct({
  type: Schema.Literal("tool_result"),
  toolCallId: Schema.String,
  content: Schema.Array(Schema.Union([IrTextSchema, IrImageSchema])),
  isError: Schema.optional(Schema.Boolean),
});

const IrReasoningSchema = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
  signature: Schema.optional(Schema.String),
  redacted: Schema.optional(Schema.String),
});

export const IrContentSchema = Schema.Union([
  IrTextSchema,
  IrImageSchema,
  IrToolCallSchema,
  IrToolResultSchema,
  IrReasoningSchema,
]);

export const IrMessageSchema = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant", "tool"]),
  content: Schema.Array(IrContentSchema),
});

export const IrToolSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  parameters: Schema.Unknown,
  strict: Schema.optional(Schema.Boolean),
  cache: Schema.optional(Schema.Boolean),
});

export const IrToolChoiceSchema = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({ name: Schema.String }),
]);

export const IrReasoningConfigSchema = Schema.Struct({
  mode: Schema.Literals(["off", "effort", "budget"]),
  effort: Schema.optional(Schema.String),
  budget: Schema.optional(Schema.Number),
  summary: Schema.optional(Schema.Boolean),
  signature: Schema.optional(Schema.Boolean),
});

export const IrSamplingSchema = Schema.Struct({
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Array(Schema.String)),
  seed: Schema.optional(Schema.Number),
  presencePenalty: Schema.optional(Schema.Number),
  frequencyPenalty: Schema.optional(Schema.Number),
});

export const IrRequestSchema = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(IrMessageSchema),
  tools: Schema.Array(IrToolSchema),
  toolChoice: Schema.optional(IrToolChoiceSchema),
  parallelToolCalls: Schema.optional(Schema.Boolean),
  sampling: IrSamplingSchema,
  reasoning: Schema.optional(IrReasoningConfigSchema),
  stream: Schema.Boolean,
  responseFormat: Schema.optional(Schema.Unknown),
  previousResponseId: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.String),
});

export const IrUsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  reasoningTokens: Schema.Number,
});

export const IrFinishReasonSchema = Schema.Literals([
  "stop",
  "length",
  "tool_calls",
  "content_filter",
  "refusal",
  "pause",
]);

export const IrErrorSchema = Schema.Struct({
  message: Schema.String,
  type: Schema.String,
  code: Schema.optional(Schema.String),
});

export const IrResponseStatusSchema = Schema.Literals([
  "completed",
  "incomplete",
  "failed",
]);

export const IrResponseSchema = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  content: Schema.Array(IrContentSchema),
  finishReason: IrFinishReasonSchema,
  usage: IrUsageSchema,
  status: IrResponseStatusSchema,
  incompleteReason: Schema.optional(Schema.String),
});

export const IrEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("start"), id: Schema.String, model: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("reasoning_delta"),
    text: Schema.String,
    signature: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool_start"),
    index: Schema.Number,
    id: Schema.String,
    name: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("tool_args_delta"), index: Schema.Number, json: Schema.String }),
  Schema.Struct({ type: Schema.Literal("finish"), reason: IrFinishReasonSchema, usage: IrUsageSchema }),
  Schema.Struct({ type: Schema.Literal("error"), error: IrErrorSchema }),
]);

export const emptyUsage = (): IrUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

export const emptySampling = (): IrSampling => ({});

export function textOf(content: ReadonlyArray<IrContent>): string {
  let out = "";
  for (const part of content) {
    if (part.type === "text") out += part.text;
  }
  return out;
}

export function reasoningOf(content: ReadonlyArray<IrContent>): IrReasoning | null {
  for (const part of content) {
    if (part.type === "reasoning") return part;
  }
  return null;
}

export function toolCallsOf(content: ReadonlyArray<IrContent>): IrToolCall[] {
  const out: IrToolCall[] = [];
  for (const part of content) {
    if (part.type === "tool_call") out.push(part);
  }
  return out;
}

export function systemText(request: IrRequest): string {
  const parts: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "system") continue;
    const text = textOf(message.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}
