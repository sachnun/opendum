import { Schema } from "effect";

export const ResponseInputText = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String,
});

export const ResponseInputImage = Schema.Struct({
  type: Schema.Literal("input_image"),
  detail: Schema.optional(Schema.Literals(["low", "high", "auto"])),
  file_id: Schema.optional(Schema.NullOr(Schema.String)),
  image_url: Schema.optional(Schema.NullOr(Schema.String)),
});

export const ResponseInputFile = Schema.Struct({
  type: Schema.Literal("input_file"),
  file_data: Schema.optional(Schema.String),
  file_id: Schema.optional(Schema.NullOr(Schema.String)),
  filename: Schema.optional(Schema.String),
});

export const ResponseInputAudio = Schema.Struct({
  type: Schema.Literal("input_audio"),
  input_audio: Schema.Struct({
    data: Schema.String,
    format: Schema.Literals(["mp3", "wav"]),
  }),
});

export const ResponseInputContent = Schema.Union([
  ResponseInputText,
  ResponseInputImage,
  ResponseInputFile,
  ResponseInputAudio,
]);

export const EasyInputMessage = Schema.Struct({
  type: Schema.optional(Schema.Literal("message")),
  role: Schema.Literals(["user", "assistant", "system", "developer"]),
  content: Schema.Union([Schema.String, Schema.Array(ResponseInputContent)]),
});

export const ResponseInputMessageItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.Literal("message")),
  role: Schema.Literals(["user", "system", "developer"]),
  content: Schema.Array(ResponseInputContent),
  status: Schema.optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
});

export const ResponseOutputText = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.optional(Schema.Array(Schema.Unknown)),
  logprobs: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const ResponseOutputRefusal = Schema.Struct({
  type: Schema.Literal("refusal"),
  refusal: Schema.String,
});

export const ResponseOutputMessage = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  status: Schema.Literals(["in_progress", "completed", "incomplete"]),
  content: Schema.Array(Schema.Union([ResponseOutputText, ResponseOutputRefusal])),
});

export const ResponseFunctionToolCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
});

export const ResponseReasoningSummary = Schema.Struct({
  type: Schema.Literal("summary_text"),
  text: Schema.String,
});

export const ResponseReasoningItem = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("reasoning"),
  summary: Schema.Array(ResponseReasoningSummary),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.Literals(["in_progress", "completed", "incomplete"])),
});

export const ResponseFunctionCallOutputItem = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  call_id: Schema.String,
  output: Schema.String,
  id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.Literals(["in_progress", "completed", "incomplete"]))),
});

export const ResponseItemReference = Schema.Struct({
  type: Schema.Literal("item_reference"),
  id: Schema.String,
});

export const ResponseInputItem = Schema.Union([
  EasyInputMessage,
  ResponseInputMessageItem,
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseReasoningItem,
  ResponseFunctionCallOutputItem,
  ResponseItemReference,
]);

export const ResponseInput = Schema.Union([Schema.String, Schema.Array(ResponseInputItem)]);

export const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  parameters: Schema.optional(Schema.Unknown),
  strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const BuiltinTool = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export const Tool = Schema.Union([FunctionTool, BuiltinTool]);

export const ToolChoiceFunction = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
});

export const ToolChoiceTypes = Schema.Struct({
  type: Schema.Literals([
    "file_search",
    "web_search_preview",
    "computer_use_preview",
    "web_search_preview_2025_03_11",
    "image_generation",
    "code_interpreter",
  ]),
});

export const ToolChoiceOptions = Schema.Literals(["none", "auto", "required"]);

export const ToolChoice = Schema.Union([ToolChoiceOptions, ToolChoiceTypes, ToolChoiceFunction]);

export const Reasoning = Schema.Struct({
  effort: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  generate_summary: Schema.optional(Schema.NullOr(Schema.String)),
});

export const TextFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  name: Schema.String,
  schema: Schema.Unknown,
  strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
  description: Schema.optional(Schema.String),
});

export const TextConfig = Schema.Struct({
  format: Schema.optional(
    Schema.Union([Schema.Struct({ type: Schema.Literal("text") }), TextFormat])
  ),
  verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"])),
});

export const ResponseCreateParamsBase = Schema.Struct({
  model: Schema.String,
  input: ResponseInput,
  background: Schema.optional(Schema.NullOr(Schema.Boolean)),
  include: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  parallel_tool_calls: Schema.optional(Schema.NullOr(Schema.Boolean)),
  previous_response_id: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning: Schema.optional(Schema.NullOr(Reasoning)),
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  store: Schema.optional(Schema.NullOr(Schema.Boolean)),
  stream: Schema.optional(Schema.NullOr(Schema.Boolean)),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  text: Schema.optional(TextConfig),
  tool_choice: Schema.optional(ToolChoice),
  tools: Schema.optional(Schema.Array(Tool)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  truncation: Schema.optional(Schema.NullOr(Schema.Literals(["auto", "disabled"]))),
  user: Schema.optional(Schema.String),
  prompt_cache_key: Schema.optional(Schema.String),
});

export const ResponseCreateParams = Schema.StructWithRest(ResponseCreateParamsBase, [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export const ResponseError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

export const ResponseIncompleteDetails = Schema.Struct({
  reason: Schema.optional(Schema.String),
});

export const ResponseUsage = Schema.Struct({
  input_tokens: Schema.Number,
  input_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: Schema.optional(Schema.Number),
        cache_write_tokens: Schema.optional(Schema.Number),
      })
    )
  ),
  output_tokens: Schema.Number,
  output_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) }))
  ),
  total_tokens: Schema.Number,
});

export const ResponseOutputItem = Schema.Union([
  ResponseOutputMessage,
  ResponseFunctionToolCall,
  ResponseReasoningItem,
]);

export const Response = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("response"),
  created_at: Schema.optional(Schema.Number),
  model: Schema.String,
  output: Schema.Array(ResponseOutputItem),
  status: Schema.Literals(["completed", "in_progress", "incomplete", "failed", "cancelled", "queued"]),
  usage: Schema.optional(Schema.NullOr(ResponseUsage)),
  error: Schema.optional(Schema.NullOr(ResponseError)),
  incomplete_details: Schema.optional(Schema.NullOr(ResponseIncompleteDetails)),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  tool_choice: Schema.optional(ToolChoice),
  tools: Schema.optional(Schema.Array(Tool)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  previous_response_id: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning: Schema.optional(Schema.NullOr(Reasoning)),
  output_text: Schema.optional(Schema.String),
});

export const ResponseCreatedEvent = Schema.Struct({
  type: Schema.Literal("response.created"),
  response: Response,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseInProgressEvent = Schema.Struct({
  type: Schema.Literal("response.in_progress"),
  response: Response,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseOutputItemAddedEvent = Schema.Struct({
  type: Schema.Literal("response.output_item.added"),
  output_index: Schema.Number,
  item: ResponseOutputItem,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseOutputItemDoneEvent = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  output_index: Schema.Number,
  item: ResponseOutputItem,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseContentPartAddedEvent = Schema.Struct({
  type: Schema.Literal("response.content_part.added"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  part: Schema.Unknown,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseContentPartDoneEvent = Schema.Struct({
  type: Schema.Literal("response.content_part.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  part: Schema.Unknown,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  delta: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseTextDoneEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  text: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseReasoningSummaryTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  summary_index: Schema.Number,
  delta: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseReasoningSummaryTextDoneEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  summary_index: Schema.Number,
  text: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseReasoningTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_text.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  content_index: Schema.Number,
  delta: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseFunctionCallArgumentsDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.delta"),
  item_id: Schema.String,
  output_index: Schema.Number,
  delta: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseFunctionCallArgumentsDoneEvent = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.done"),
  item_id: Schema.String,
  output_index: Schema.Number,
  arguments: Schema.String,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseCompletedEvent = Schema.Struct({
  type: Schema.Literal("response.completed"),
  response: Response,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseIncompleteEvent = Schema.Struct({
  type: Schema.Literal("response.incomplete"),
  response: Response,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseFailedEvent = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Response,
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.String,
  param: Schema.optional(Schema.NullOr(Schema.String)),
  sequence_number: Schema.optional(Schema.Number),
});

export const ResponseStreamEvent = Schema.Union([
  ResponseCreatedEvent,
  ResponseInProgressEvent,
  ResponseOutputItemAddedEvent,
  ResponseOutputItemDoneEvent,
  ResponseContentPartAddedEvent,
  ResponseContentPartDoneEvent,
  ResponseTextDeltaEvent,
  ResponseTextDoneEvent,
  ResponseReasoningSummaryTextDeltaEvent,
  ResponseReasoningSummaryTextDoneEvent,
  ResponseReasoningTextDeltaEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseCompletedEvent,
  ResponseIncompleteEvent,
  ResponseFailedEvent,
  ResponseErrorEvent,
]);

export type ResponseInputContent = typeof ResponseInputContent.Type;
export type EasyInputMessage = typeof EasyInputMessage.Type;
export type ResponseInputMessageItem = typeof ResponseInputMessageItem.Type;
export type ResponseOutputText = typeof ResponseOutputText.Type;
export type ResponseOutputMessage = typeof ResponseOutputMessage.Type;
export type ResponseFunctionToolCall = typeof ResponseFunctionToolCall.Type;
export type ResponseReasoningItem = typeof ResponseReasoningItem.Type;
export type ResponseFunctionCallOutputItem = typeof ResponseFunctionCallOutputItem.Type;
export type ResponseInputItem = typeof ResponseInputItem.Type;
export type ResponseInput = typeof ResponseInput.Type;
export type FunctionTool = typeof FunctionTool.Type;
export type Tool = typeof Tool.Type;
export type ToolChoice = typeof ToolChoice.Type;
export type Reasoning = typeof Reasoning.Type;
export type TextConfig = typeof TextConfig.Type;
export type ResponseCreateParams = typeof ResponseCreateParams.Type;
export type ResponseUsage = typeof ResponseUsage.Type;
export type ResponseOutputItem = typeof ResponseOutputItem.Type;
export type Response = typeof Response.Type;
export type ResponseStreamEvent = typeof ResponseStreamEvent.Type;
export type ResponseCreatedEvent = typeof ResponseCreatedEvent.Type;
export type ResponseOutputItemAddedEvent = typeof ResponseOutputItemAddedEvent.Type;
export type ResponseOutputItemDoneEvent = typeof ResponseOutputItemDoneEvent.Type;
export type ResponseTextDeltaEvent = typeof ResponseTextDeltaEvent.Type;
export type ResponseReasoningSummaryTextDeltaEvent = typeof ResponseReasoningSummaryTextDeltaEvent.Type;
export type ResponseReasoningTextDeltaEvent = typeof ResponseReasoningTextDeltaEvent.Type;
export type ResponseFunctionCallArgumentsDeltaEvent = typeof ResponseFunctionCallArgumentsDeltaEvent.Type;
export type ResponseCompletedEvent = typeof ResponseCompletedEvent.Type;
export type ResponseIncompleteEvent = typeof ResponseIncompleteEvent.Type;
export type ResponseFailedEvent = typeof ResponseFailedEvent.Type;
export type ResponseErrorEvent = typeof ResponseErrorEvent.Type;
