import { Schema } from "effect";

export type CacheControlEphemeral = { type: "ephemeral"; ttl?: "5m" | "1h" };

export type TextBlockParam = {
  type: "text";
  text: string;
  cache_control?: CacheControlEphemeral | null;
  citations?: unknown[] | null;
};

export type Base64ImageSource = { type: "base64"; media_type: string; data: string };

export type UrlImageSource = { type: "url"; url: string };

export type ImageBlockParam = {
  type: "image";
  source: Base64ImageSource | UrlImageSource;
  cache_control?: CacheControlEphemeral | null;
};

export type DocumentBlockParam = {
  type: "document";
  source: unknown;
  cache_control?: CacheControlEphemeral | null;
  citations?: unknown;
  context?: string | null;
  title?: string | null;
};

export type ThinkingBlockParam = { type: "thinking"; thinking: string; signature: string };

export type RedactedThinkingBlockParam = { type: "redacted_thinking"; data: string };

export type ToolUseBlockParam = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControlEphemeral | null;
};

export type ToolResultBlockParam = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<ContentBlockParam>;
  is_error?: boolean;
  cache_control?: CacheControlEphemeral | null;
};

export type ServerToolUseBlockParam = {
  type: "server_tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControlEphemeral | null;
};

export type WebSearchToolResultBlockParam = {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown;
  cache_control?: CacheControlEphemeral | null;
};

export type ContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | DocumentBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ServerToolUseBlockParam
  | WebSearchToolResultBlockParam;

export type MessageParam = { role: "user" | "assistant"; content: string | ContentBlockParam[] };

export type Tool = {
  name: string;
  input_schema: unknown;
  description?: string;
  cache_control?: CacheControlEphemeral | null;
  type?: string;
  strict?: boolean;
};

export type ToolChoiceAuto = { type: "auto"; disable_parallel_tool_use?: boolean };
export type ToolChoiceAny = { type: "any"; disable_parallel_tool_use?: boolean };
export type ToolChoiceTool = { type: "tool"; name: string; disable_parallel_tool_use?: boolean };
export type ToolChoiceNone = { type: "none" };
export type ToolChoice = ToolChoiceAuto | ToolChoiceAny | ToolChoiceTool | ToolChoiceNone;

export type ThinkingConfigEnabled = { type: "enabled"; budget_tokens: number };
export type ThinkingConfigDisabled = { type: "disabled" };
export type ThinkingConfigAdaptive = { type: "adaptive" };
export type ThinkingConfigParam =
  | ThinkingConfigEnabled
  | ThinkingConfigDisabled
  | ThinkingConfigAdaptive;

export type Metadata = { user_id?: string | null };

export type MessageCreateParams = {
  model: string;
  max_tokens: number;
  messages: MessageParam[];
  metadata?: Metadata;
  service_tier?: "auto" | "standard_only";
  stop_sequences?: string[];
  stream?: boolean;
  system?: string | TextBlockParam[];
  temperature?: number;
  thinking?: ThinkingConfigParam;
  tool_choice?: ToolChoice;
  tools?: Tool[];
  top_k?: number;
  top_p?: number;
  [key: string]: unknown;
};

export type TextBlock = {
  type: "text";
  text: string;
  citations?: unknown[] | null;
};

export type ThinkingBlock = { type: "thinking"; thinking: string; signature: string };

export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string };

export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

export type ServerToolUseBlock = { type: "server_tool_use"; id: string; name: string; input: unknown };

export type WebSearchToolResultBlock = {
  type: "web_search_tool_result";
  tool_use_id: string;
  content: unknown;
};

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock;

export type CacheCreation = {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: CacheCreation | null;
  server_tool_use?: unknown;
  service_tier?: "standard" | "priority" | "batch" | null;
};

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | "model_context_window_exceeded";

export type Message = {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
};

export type MessageDeltaUsage = {
  input_tokens?: number | null;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: unknown;
};

export type MessageStartEvent = { type: "message_start"; message: Message };

export type MessageDeltaEvent = {
  type: "message_delta";
  delta: { stop_reason: StopReason | null; stop_sequence: string | null };
  usage: MessageDeltaUsage;
};

export type MessageStopEvent = { type: "message_stop" };

export type ContentBlockStartEvent = {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
};

export type TextDelta = { type: "text_delta"; text: string };
export type InputJsonDelta = { type: "input_json_delta"; partial_json: string };
export type ThinkingDelta = { type: "thinking_delta"; thinking: string };
export type SignatureDelta = { type: "signature_delta"; signature: string };
export type CitationsDelta = { type: "citations_delta"; citation: unknown };
export type RawContentBlockDelta =
  | TextDelta
  | InputJsonDelta
  | ThinkingDelta
  | SignatureDelta
  | CitationsDelta;

export type ContentBlockDeltaEvent = {
  type: "content_block_delta";
  index: number;
  delta: RawContentBlockDelta;
};

export type ContentBlockStopEvent = { type: "content_block_stop"; index: number };
export type PingEvent = { type: "ping" };
export type ErrorEvent = { type: "error"; error: { type: string; message: string } };

export type RawMessageStreamEvent =
  | MessageStartEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | PingEvent
  | ErrorEvent;

export const CacheControlEphemeral = Schema.Struct({
  type: Schema.Literal("ephemeral"),
  ttl: Schema.optional(Schema.Literals(["5m", "1h"])),
});

const CacheControl = Schema.optional(Schema.NullOr(CacheControlEphemeral));

export const TextBlockParam = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  cache_control: CacheControl,
  citations: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const Base64ImageSource = Schema.Struct({
  type: Schema.Literal("base64"),
  media_type: Schema.String,
  data: Schema.String,
});

export const UrlImageSource = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
});

export const ImageBlockParam = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Union([Base64ImageSource, UrlImageSource]),
  cache_control: CacheControl,
});

export const DocumentBlockParam = Schema.Struct({
  type: Schema.Literal("document"),
  source: Schema.Unknown,
  cache_control: CacheControl,
  citations: Schema.optional(Schema.NullOr(Schema.Unknown)),
  context: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ThinkingBlockParam = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.String,
});

export const RedactedThinkingBlockParam = Schema.Struct({
  type: Schema.Literal("redacted_thinking"),
  data: Schema.String,
});

export const ToolUseBlockParam = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cache_control: CacheControl,
});

export const ToolResultBlockParam = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])),
  is_error: Schema.optional(Schema.Boolean),
  cache_control: CacheControl,
});

export const ServerToolUseBlockParam = Schema.Struct({
  type: Schema.Literal("server_tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
  cache_control: CacheControl,
});

export const WebSearchToolResultBlockParam = Schema.Struct({
  type: Schema.Literal("web_search_tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Unknown,
  cache_control: CacheControl,
});

const ContentBlockParamUnion = Schema.Union([
  TextBlockParam,
  ImageBlockParam,
  DocumentBlockParam,
  ThinkingBlockParam,
  RedactedThinkingBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  ServerToolUseBlockParam,
  WebSearchToolResultBlockParam,
]);

export const ContentBlockParam = ContentBlockParamUnion;

export const MessageParam = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  content: Schema.Union([Schema.String, Schema.Array(ContentBlockParamUnion)]),
});

export const Tool = Schema.Struct({
  name: Schema.String,
  input_schema: Schema.Unknown,
  description: Schema.optional(Schema.String),
  cache_control: CacheControl,
  type: Schema.optional(Schema.String),
  strict: Schema.optional(Schema.Boolean),
});

export const ToolChoiceAuto = Schema.Struct({
  type: Schema.Literal("auto"),
  disable_parallel_tool_use: Schema.optional(Schema.Boolean),
});

export const ToolChoiceAny = Schema.Struct({
  type: Schema.Literal("any"),
  disable_parallel_tool_use: Schema.optional(Schema.Boolean),
});

export const ToolChoiceTool = Schema.Struct({
  type: Schema.Literal("tool"),
  name: Schema.String,
  disable_parallel_tool_use: Schema.optional(Schema.Boolean),
});

export const ToolChoiceNone = Schema.Struct({
  type: Schema.Literal("none"),
});

export const ToolChoice = Schema.Union([ToolChoiceAuto, ToolChoiceAny, ToolChoiceTool, ToolChoiceNone]);

export const ThinkingConfigEnabled = Schema.Struct({
  type: Schema.Literal("enabled"),
  budget_tokens: Schema.Number,
});

export const ThinkingConfigDisabled = Schema.Struct({
  type: Schema.Literal("disabled"),
});

export const ThinkingConfigAdaptive = Schema.Struct({
  type: Schema.Literal("adaptive"),
});

export const ThinkingConfigParam = Schema.Union([
  ThinkingConfigEnabled,
  ThinkingConfigDisabled,
  ThinkingConfigAdaptive,
]);

export const Metadata = Schema.Struct({
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
});

export const MessageCreateParamsBase = Schema.Struct({
  model: Schema.String,
  max_tokens: Schema.Number,
  messages: Schema.Array(MessageParam),
  metadata: Schema.optional(Metadata),
  service_tier: Schema.optional(Schema.Literals(["auto", "standard_only"])),
  stop_sequences: Schema.optional(Schema.Array(Schema.String)),
  stream: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Union([Schema.String, Schema.Array(TextBlockParam)])),
  temperature: Schema.optional(Schema.Number),
  thinking: Schema.optional(ThinkingConfigParam),
  tool_choice: Schema.optional(ToolChoice),
  tools: Schema.optional(Schema.Array(Tool)),
  top_k: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
});

export const MessageCreateParams = Schema.StructWithRest(MessageCreateParamsBase, [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export const TextBlock = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
  citations: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});

export const ThinkingBlock = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  signature: Schema.String,
});

export const RedactedThinkingBlock = Schema.Struct({
  type: Schema.Literal("redacted_thinking"),
  data: Schema.String,
});

export const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});

export const ServerToolUseBlock = Schema.Struct({
  type: Schema.Literal("server_tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});

export const WebSearchToolResultBlock = Schema.Struct({
  type: Schema.Literal("web_search_tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Unknown,
});

export const ContentBlock = Schema.Union([
  TextBlock,
  ThinkingBlock,
  RedactedThinkingBlock,
  ToolUseBlock,
  ServerToolUseBlock,
  WebSearchToolResultBlock,
]);

export const CacheCreation = Schema.Struct({
  ephemeral_5m_input_tokens: Schema.optional(Schema.Number),
  ephemeral_1h_input_tokens: Schema.optional(Schema.Number),
});

export const Usage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation: Schema.optional(Schema.NullOr(CacheCreation)),
  server_tool_use: Schema.optional(Schema.NullOr(Schema.Unknown)),
  service_tier: Schema.optional(Schema.NullOr(Schema.Literals(["standard", "priority", "batch"]))),
});

export const StopReason = Schema.Literals([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

export const Message = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  content: Schema.Array(ContentBlock),
  model: Schema.String,
  stop_reason: Schema.NullOr(StopReason),
  stop_sequence: Schema.NullOr(Schema.String),
  usage: Usage,
});

export const MessageDeltaUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  output_tokens: Schema.Number,
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  server_tool_use: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const MessageStartEvent = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Message,
});

export const MessageDeltaEvent = Schema.Struct({
  type: Schema.Literal("message_delta"),
  delta: Schema.Struct({
    stop_reason: Schema.NullOr(StopReason),
    stop_sequence: Schema.NullOr(Schema.String),
  }),
  usage: MessageDeltaUsage,
});

export const MessageStopEvent = Schema.Struct({
  type: Schema.Literal("message_stop"),
});

export const ContentBlockStartEvent = Schema.Struct({
  type: Schema.Literal("content_block_start"),
  index: Schema.Number,
  content_block: ContentBlock,
});

export const TextDelta = Schema.Struct({
  type: Schema.Literal("text_delta"),
  text: Schema.String,
});

export const InputJsonDelta = Schema.Struct({
  type: Schema.Literal("input_json_delta"),
  partial_json: Schema.String,
});

export const ThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking_delta"),
  thinking: Schema.String,
});

export const SignatureDelta = Schema.Struct({
  type: Schema.Literal("signature_delta"),
  signature: Schema.String,
});

export const CitationsDelta = Schema.Struct({
  type: Schema.Literal("citations_delta"),
  citation: Schema.Unknown,
});

export const RawContentBlockDelta = Schema.Union([
  TextDelta,
  InputJsonDelta,
  ThinkingDelta,
  SignatureDelta,
  CitationsDelta,
]);

export const ContentBlockDeltaEvent = Schema.Struct({
  type: Schema.Literal("content_block_delta"),
  index: Schema.Number,
  delta: RawContentBlockDelta,
});

export const ContentBlockStopEvent = Schema.Struct({
  type: Schema.Literal("content_block_stop"),
  index: Schema.Number,
});

export const PingEvent = Schema.Struct({
  type: Schema.Literal("ping"),
});

export const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.Struct({
    type: Schema.String,
    message: Schema.String,
  }),
});

export const RawMessageStreamEvent = Schema.Union([
  MessageStartEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  PingEvent,
  ErrorEvent,
]);
