import { Schema } from "effect";

export const FunctionDefinition = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  parameters: Schema.optional(Schema.Unknown),
  strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

export const ChatCompletionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: FunctionDefinition,
});

export const ChatCompletionNamedToolChoice = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String }),
});

export const ChatCompletionToolChoiceOption = Schema.Union([
  Schema.Literals(["none", "auto", "required"]),
  ChatCompletionNamedToolChoice,
]);

export const ChatCompletionContentPartText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

export const ChatCompletionContentPartRefusal = Schema.Struct({
  type: Schema.Literal("refusal"),
  refusal: Schema.String,
});

export const ChatCompletionContentPartImage = Schema.Struct({
  type: Schema.Literal("image_url"),
  image_url: Schema.Struct({
    url: Schema.String,
    detail: Schema.optional(Schema.Literals(["auto", "low", "high"])),
  }),
});

export const ChatCompletionContentPartInputAudio = Schema.Struct({
  type: Schema.Literal("input_audio"),
  input_audio: Schema.Struct({
    data: Schema.String,
    format: Schema.Literals(["wav", "mp3"]),
  }),
});

export const ChatCompletionContentPartFile = Schema.Struct({
  type: Schema.Literal("file"),
  file: Schema.Struct({
    file_data: Schema.optional(Schema.String),
    file_id: Schema.optional(Schema.String),
    filename: Schema.optional(Schema.String),
  }),
});

export const ChatCompletionContentPart = Schema.Union([
  ChatCompletionContentPartText,
  ChatCompletionContentPartImage,
  ChatCompletionContentPartInputAudio,
  ChatCompletionContentPartFile,
]);

export const ChatCompletionMessageToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
});

export const ChatCompletionMessageFunctionCall = Schema.Struct({
  name: Schema.String,
  arguments: Schema.String,
});

export const ChatCompletionSystemMessageParam = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.Union([Schema.String, Schema.Array(ChatCompletionContentPartText)]),
  name: Schema.optional(Schema.String),
});

export const ChatCompletionDeveloperMessageParam = Schema.Struct({
  role: Schema.Literal("developer"),
  content: Schema.Union([Schema.String, Schema.Array(ChatCompletionContentPartText)]),
  name: Schema.optional(Schema.String),
});

export const ChatCompletionUserMessageParam = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(ChatCompletionContentPart)]),
  name: Schema.optional(Schema.String),
});

export const ChatCompletionAssistantMessageParam = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.optional(
    Schema.NullOr(
      Schema.Union([
        Schema.String,
        Schema.Array(Schema.Union([ChatCompletionContentPartText, ChatCompletionContentPartRefusal])),
      ])
    )
  ),
  name: Schema.optional(Schema.String),
  refusal: Schema.optional(Schema.NullOr(Schema.String)),
  function_call: Schema.optional(Schema.NullOr(ChatCompletionMessageFunctionCall)),
  tool_calls: Schema.optional(Schema.Array(ChatCompletionMessageToolCall)),
  audio: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
});

export const ChatCompletionToolMessageParam = Schema.Struct({
  role: Schema.Literal("tool"),
  tool_call_id: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(ChatCompletionContentPartText)]),
});

export const ChatCompletionFunctionMessageParam = Schema.Struct({
  role: Schema.Literal("function"),
  name: Schema.String,
  content: Schema.NullOr(Schema.String),
});

export const ChatCompletionMessageParam = Schema.Union([
  ChatCompletionSystemMessageParam,
  ChatCompletionDeveloperMessageParam,
  ChatCompletionUserMessageParam,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionFunctionMessageParam,
]);

export const ResponseFormatText = Schema.Struct({ type: Schema.Literal("text") });
export const ResponseFormatJsonObject = Schema.Struct({ type: Schema.Literal("json_object") });
export const ResponseFormatJsonSchema = Schema.Struct({
  type: Schema.Literal("json_schema"),
  json_schema: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    schema: Schema.optional(Schema.Unknown),
    strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
});

export const ResponseFormat = Schema.Union([
  ResponseFormatText,
  ResponseFormatJsonObject,
  ResponseFormatJsonSchema,
]);

export const StreamOptions = Schema.Struct({
  include_usage: Schema.optional(Schema.Boolean),
});

export const ReasoningEffort = Schema.Literals([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const ChatCompletionCreateParamsBase = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(ChatCompletionMessageParam),
  stream: Schema.optional(Schema.Boolean),
  stream_options: Schema.optional(Schema.NullOr(StreamOptions)),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  max_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  n: Schema.optional(Schema.NullOr(Schema.Number)),
  stop: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  presence_penalty: Schema.optional(Schema.NullOr(Schema.Number)),
  frequency_penalty: Schema.optional(Schema.NullOr(Schema.Number)),
  seed: Schema.optional(Schema.NullOr(Schema.Number)),
  logprobs: Schema.optional(Schema.NullOr(Schema.Boolean)),
  top_logprobs: Schema.optional(Schema.NullOr(Schema.Number)),
  logit_bias: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Number))),
  user: Schema.optional(Schema.String),
  tools: Schema.optional(Schema.Array(ChatCompletionTool)),
  tool_choice: Schema.optional(ChatCompletionToolChoiceOption),
  parallel_tool_calls: Schema.optional(Schema.Boolean),
  response_format: Schema.optional(ResponseFormat),
  reasoning_effort: Schema.optional(Schema.NullOr(ReasoningEffort)),
  reasoning: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  store: Schema.optional(Schema.NullOr(Schema.Boolean)),
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  prompt_cache_key: Schema.optional(Schema.String),
});

export const ChatCompletionCreateParams = Schema.StructWithRest(ChatCompletionCreateParamsBase, [
  Schema.Record(Schema.String, Schema.Unknown),
]);

export const CompletionUsage = Schema.Struct({
  prompt_tokens: Schema.Number,
  completion_tokens: Schema.Number,
  total_tokens: Schema.Number,
  prompt_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: Schema.optional(Schema.Number),
        cache_write_tokens: Schema.optional(Schema.Number),
        audio_tokens: Schema.optional(Schema.Number),
      })
    )
  ),
  completion_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optional(Schema.Number),
        audio_tokens: Schema.optional(Schema.Number),
        accepted_prediction_tokens: Schema.optional(Schema.Number),
        rejected_prediction_tokens: Schema.optional(Schema.Number),
      })
    )
  ),
});

export const ChatCompletionMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.NullOr(Schema.String),
  refusal: Schema.optional(Schema.NullOr(Schema.String)),
  annotations: Schema.optional(Schema.Array(Schema.Unknown)),
  audio: Schema.optional(Schema.NullOr(Schema.Unknown)),
  function_call: Schema.optional(Schema.NullOr(ChatCompletionMessageFunctionCall)),
  tool_calls: Schema.optional(Schema.Array(ChatCompletionMessageToolCall)),
});

export const ChatCompletionChoice = Schema.Struct({
  index: Schema.Number,
  message: ChatCompletionMessage,
  finish_reason: Schema.NullOr(
    Schema.Literals(["stop", "length", "tool_calls", "content_filter", "function_call"])
  ),
  logprobs: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const ChatCompletion = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(ChatCompletionChoice),
  usage: Schema.optional(CompletionUsage),
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  system_fingerprint: Schema.optional(Schema.String),
});

export const ChatCompletionChunkDelta = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  refusal: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
  reasoning: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        index: Schema.Number,
        id: Schema.optional(Schema.String),
        type: Schema.optional(Schema.String),
        function: Schema.optional(
          Schema.Struct({
            name: Schema.optional(Schema.String),
            arguments: Schema.optional(Schema.String),
          })
        ),
      })
    )
  ),
});

export const ChatCompletionChunkChoice = Schema.Struct({
  index: Schema.Number,
  delta: ChatCompletionChunkDelta,
  finish_reason: Schema.optional(
    Schema.NullOr(Schema.Literals(["stop", "length", "tool_calls", "content_filter", "function_call"]))
  ),
  logprobs: Schema.optional(Schema.NullOr(Schema.Unknown)),
});

export const ChatCompletionChunk = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("chat.completion.chunk"),
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(ChatCompletionChunkChoice),
  usage: Schema.optional(Schema.NullOr(CompletionUsage)),
  service_tier: Schema.optional(Schema.NullOr(Schema.String)),
  system_fingerprint: Schema.optional(Schema.String),
});

export const OpenAIErrorBody = Schema.Struct({
  message: Schema.String,
  type: Schema.String,
  param: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.String)),
});

export const OpenAIErrorEnvelope = Schema.Struct({
  error: OpenAIErrorBody,
});

export type FunctionDefinition = typeof FunctionDefinition.Type;
export type ChatCompletionTool = typeof ChatCompletionTool.Type;
export type ChatCompletionToolChoiceOption = typeof ChatCompletionToolChoiceOption.Type;
export type ChatCompletionContentPart = typeof ChatCompletionContentPart.Type;
export type ChatCompletionContentPartText = typeof ChatCompletionContentPartText.Type;
export type ChatCompletionMessageToolCall = typeof ChatCompletionMessageToolCall.Type;
export type ChatCompletionSystemMessageParam = typeof ChatCompletionSystemMessageParam.Type;
export type ChatCompletionDeveloperMessageParam = typeof ChatCompletionDeveloperMessageParam.Type;
export type ChatCompletionUserMessageParam = typeof ChatCompletionUserMessageParam.Type;
export type ChatCompletionAssistantMessageParam = typeof ChatCompletionAssistantMessageParam.Type;
export type ChatCompletionToolMessageParam = typeof ChatCompletionToolMessageParam.Type;
export type ChatCompletionMessageParam = typeof ChatCompletionMessageParam.Type;
export type ResponseFormat = typeof ResponseFormat.Type;
export type ChatCompletionCreateParams = typeof ChatCompletionCreateParams.Type;
export type CompletionUsage = typeof CompletionUsage.Type;
export type ChatCompletionMessage = typeof ChatCompletionMessage.Type;
export type ChatCompletionChoice = typeof ChatCompletionChoice.Type;
export type ChatCompletion = typeof ChatCompletion.Type;
export type ChatCompletionChunkDelta = typeof ChatCompletionChunkDelta.Type;
export type ChatCompletionChunkChoice = typeof ChatCompletionChunkChoice.Type;
export type ChatCompletionChunk = typeof ChatCompletionChunk.Type;
export type OpenAIErrorEnvelope = typeof OpenAIErrorEnvelope.Type;
