import { Result } from "effect";
import type {
  ChatCompletion,
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionToolChoiceOption,
  ChatCompletionUserMessageParam,
} from "@opendum/protocol/openai/chat";
import { emptySampling, emptyUsage, type IrContent, type IrEvent, type IrFinishReason, type IrImage, type IrMessage, type IrRequest, type IrResponse, type IrText, type IrTool, type IrToolChoice, type IrUsage } from "@opendum/protocol/ir";
import { fromChatUsage, mergeUsage, toChatUsage } from "@opendum/protocol/usage";

type Mutable<T> = T extends ReadonlyArray<infer Element>
  ? Array<Mutable<Element>>
  : T extends object
    ? { -readonly [Key in keyof T]: T[Key] }
    : T;

type Json = { readonly [key: string]: unknown };

const DEFAULT_MAX_TOKENS = 4096;

function record(value: unknown): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Json;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseJson(value: string): unknown {
  const parsed = Result.try({ try: () => JSON.parse(value) as unknown, catch: () => null });
  return Result.isSuccess(parsed) ? parsed.success : null;
}

function dataUri(value: string): { mediaType: string; data: string } | null {
  if (!value.startsWith("data:")) return null;
  const trimmed = value.slice("data:".length);
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const header = trimmed.slice(0, comma);
  const data = trimmed.slice(comma + 1);
  if (!data) return null;
  const mediaType = header.endsWith(";base64") ? header.slice(0, -";base64".length) : header;
  return { mediaType: mediaType || "image/png", data };
}

export function imageUrlToIr(value: unknown): IrImage | null {
  const url = typeof value === "string" ? value : text(record(value).url);
  if (!url) return null;
  const parsed = dataUri(url);
  if (parsed) {
    return { type: "image", source: "base64", mediaType: parsed.mediaType, data: parsed.data };
  }
  return { type: "image", source: "url", url };
}

export function irImageToUrl(block: IrContent | IrImage): string {
  if (block.type !== "image") return "";
  if (block.source === "base64") return `data:${block.mediaType};base64,${block.data}`;
  return block.url;
}

function contentParts(content: unknown): Array<IrText | IrImage> {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  const out: Array<IrText | IrImage> = [];
  for (const raw of array(content)) {
    const part = record(raw);
    switch (text(part.type)) {
      case "text":
      case "input_text":
      case "output_text": {
        const value = text(part.text);
        if (value) out.push({ type: "text", text: value });
        break;
      }
      case "refusal": {
        const value = text(part.refusal);
        if (value) out.push({ type: "text", text: value });
        break;
      }
      case "image_url": {
        const image = imageUrlToIr(part.image_url);
        if (image) out.push(image);
        break;
      }
      case "image": {
        const image = imageUrlToIr(part.source);
        if (image) out.push(image);
        break;
      }
      case "input_image": {
        const image = imageUrlToIr(part.image_url);
        if (image) out.push(image);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function toolCallToIr(value: unknown): IrContent | null {
  const call = record(value);
  const fn = record(call.function);
  const name = text(fn.name);
  if (!name) return null;
  return {
    type: "tool_call",
    id: text(call.id),
    name,
    arguments: text(fn.arguments) || "{}",
  };
}

function toolCallsToIr(message: Json): IrContent[] {
  const out: IrContent[] = [];
  for (const raw of array(message.tool_calls)) {
    const converted = toolCallToIr(raw);
    if (converted) out.push(converted);
  }
  const legacy = record(message.function_call);
  if (text(legacy.name)) {
    out.push({
      type: "tool_call",
      id: text(message.tool_call_id) || "call_legacy",
      name: text(legacy.name),
      arguments: text(legacy.arguments) || "{}",
    });
  }
  return out;
}

function messageToIr(raw: unknown): IrMessage[] {
  const message = record(raw);
  const role = text(message.role);
  if (role === "system" || role === "developer") {
    return [{ role: "system", content: contentParts(message.content) }];
  }
  if (role === "tool" || role === "function") {
    return [
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: text(message.tool_call_id),
            content: contentParts(message.content),
          },
        ],
      },
    ];
  }
  if (role === "assistant") {
    const content: IrContent[] = [...contentParts(message.content), ...toolCallsToIr(message)];
    const reasoning = text(message.reasoning_content) || text(message.reasoning);
    if (reasoning) content.unshift({ type: "reasoning", text: reasoning });
    return content.length > 0 ? [{ role: "assistant", content }] : [];
  }
  const content: IrContent[] = contentParts(message.content);
  return content.length > 0 ? [{ role: "user", content }] : [];
}

function toolToIr(raw: unknown): IrTool | null {
  const tool = record(raw);
  const fn = record(tool.function);
  const name = text(fn.name) || text(tool.name);
  if (!name) return null;
  const parameters =
    fn.parameters !== null && typeof fn.parameters === "object"
      ? fn.parameters
      : tool.parameters !== null && typeof tool.parameters === "object"
        ? tool.parameters
        : {};
  const converted: Mutable<IrTool> = { name, parameters };
  const description = text(fn.description) || text(tool.description);
  if (description) converted.description = description;
  if (typeof fn.strict === "boolean") converted.strict = fn.strict;
  return converted;
}

function toolChoiceToIr(value: unknown): IrToolChoice | undefined {
  if (value === "auto" || value === "none" || value === "required") return value;
  const choice = record(value);
  if (choice.function !== undefined) {
    const name = text(record(choice.function).name);
    return name ? { name } : undefined;
  }
  switch (text(choice.type)) {
    case "auto":
      return "auto";
    case "required":
    case "any":
      return "required";
    case "none":
      return "none";
    case "function":
    case "tool": {
      const name = text(choice.name);
      return name ? { name } : undefined;
    }
    default:
      return undefined;
  }
}

function reasoningToIr(body: Json): IrRequest["reasoning"] {
  const reasoning = record(body.reasoning);
  const nested = text(reasoning.effort);
  if (nested) return { mode: "effort", effort: nested };
  const budget = number(body.thinking_budget) || number(record(body.thinking).budget_tokens);
  if (budget > 0) return { mode: "budget", budget };
  const effort = text(body.reasoning_effort);
  if (effort === "none") return { mode: "off" };
  if (effort) return { mode: "effort", effort };
  if (body.include_thoughts === false) return { mode: "off" };
  return undefined;
}

function stopToIr(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  return array(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function decodeRequest(body: unknown): IrRequest {
  const params = record(body);
  const messages: IrMessage[] = [];
  for (const raw of array(params.messages)) {
    messages.push(...messageToIr(raw));
  }
  const tools: IrTool[] = [];
  for (const raw of array(params.tools)) {
    const converted = toolToIr(raw);
    if (converted) tools.push(converted);
  }
  const sampling: Mutable<IrRequest["sampling"]> = emptySampling();
  if (typeof params.temperature === "number") sampling.temperature = params.temperature;
  if (typeof params.top_p === "number") sampling.topP = params.top_p;
  const maxTokens = number(params.max_tokens) || number(params.max_completion_tokens);
  sampling.maxTokens = maxTokens || DEFAULT_MAX_TOKENS;
  const stop = stopToIr(params.stop);
  if (stop.length > 0) sampling.stop = stop;
  if (typeof params.seed === "number") sampling.seed = params.seed;
  if (typeof params.presence_penalty === "number") sampling.presencePenalty = params.presence_penalty;
  if (typeof params.frequency_penalty === "number") sampling.frequencyPenalty = params.frequency_penalty;
  const request: Mutable<IrRequest> = {
    model: text(params.model),
    messages,
    tools,
    sampling,
    stream: params.stream === true,
    metadata: {},
  };
  const choice = toolChoiceToIr(params.tool_choice);
  if (choice !== undefined) request.toolChoice = choice;
  if (typeof params.parallel_tool_calls === "boolean") request.parallelToolCalls = params.parallel_tool_calls;
  const reasoning = reasoningToIr(params);
  if (reasoning) request.reasoning = reasoning;
  if (params.response_format !== undefined && params.response_format !== null) {
    request.responseFormat = params.response_format;
  }
  const user = text(params.user);
  if (user) request.user = user;
  const metadata = record(params.metadata);
  if (Object.keys(metadata).length > 0) {
    request.metadata = Object.fromEntries(
      Object.entries(metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  }
  return request;
}

function irContentToChat(content: ReadonlyArray<IrContent>): {
  content: string | ChatCompletionContentPart[] | null;
  toolCalls: ChatCompletionMessageToolCall[];
  reasoning: string;
  toolResults: string[];
} {
  const parts: Mutable<ChatCompletionContentPart>[] = [];
  const toolCalls: Mutable<ChatCompletionMessageToolCall>[] = [];
  const toolResults: string[] = [];
  let reasoning = "";
  let textOnly = "";
  let hasNonText = false;
  for (const part of content) {
    switch (part.type) {
      case "text":
        parts.push({ type: "text", text: part.text });
        textOnly += part.text;
        break;
      case "image":
        parts.push({ type: "image_url", image_url: { url: irImageToUrl(part) } });
        hasNonText = true;
        break;
      case "tool_call":
        toolCalls.push({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: part.arguments },
        });
        break;
      case "tool_result":
        toolResults.push(part.content.map((item) => (item.type === "text" ? item.text : "")).join(""));
        break;
      case "reasoning":
        reasoning += part.text;
        break;
      default:
        break;
    }
  }
  const chatContent: string | Mutable<ChatCompletionContentPart>[] | null = hasNonText
    ? parts
    : textOnly || null;
  return {
    content: chatContent as string | ChatCompletionContentPart[] | null,
    toolCalls: toolCalls as ChatCompletionMessageToolCall[],
    reasoning,
    toolResults,
  };
}

export function encodeRequest(request: IrRequest): Record<string, unknown> {
  const messages: Mutable<ChatCompletionMessageParam>[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
      continue;
    }
    const results = message.content.filter((part) => part.type === "tool_result");
    for (const part of results) {
      if (part.type !== "tool_result") continue;
      const output = part.content.map((item) => (item.type === "text" ? item.text : "")).join("");
      messages.push({ role: "tool", tool_call_id: part.toolCallId, content: output });
    }
    const rest = message.content.filter((part) => part.type !== "tool_result");
    if (message.role === "tool") continue;
    if (rest.length === 0) continue;
    const converted = irContentToChat(rest);
    if (message.role === "assistant") {
      const assistant: Mutable<ChatCompletionAssistantMessageParam> & { reasoning_content?: string } = {
        role: "assistant",
        content: converted.content as Mutable<ChatCompletionAssistantMessageParam>["content"],
      };
      if (converted.toolCalls.length > 0) assistant.tool_calls = converted.toolCalls;
      if (converted.reasoning) {
        assistant.reasoning_content = converted.reasoning;
      }
      messages.push(assistant);
      continue;
    }
    messages.push({
      role: "user",
      content: (converted.content ?? "") as Mutable<ChatCompletionUserMessageParam>["content"],
    });
  }
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: request.stream,
  };
  const sampling = request.sampling;
  if (sampling.temperature !== undefined) body.temperature = sampling.temperature;
  if (sampling.topP !== undefined) body.top_p = sampling.topP;
  if (sampling.maxTokens !== undefined) body.max_tokens = sampling.maxTokens;
  if (sampling.stop !== undefined && sampling.stop.length > 0) body.stop = sampling.stop;
  if (sampling.seed !== undefined) body.seed = sampling.seed;
  if (sampling.presencePenalty !== undefined) body.presence_penalty = sampling.presencePenalty;
  if (sampling.frequencyPenalty !== undefined) body.frequency_penalty = sampling.frequencyPenalty;
  if (request.tools.length > 0) {
    const tools: Mutable<ChatCompletionTool>[] = request.tools.map((tool) => {
      const fn: Mutable<ChatCompletionTool["function"]> = {
        name: tool.name,
        parameters: tool.parameters ?? {},
      };
      if (tool.description) fn.description = tool.description;
      if (tool.strict !== undefined) fn.strict = tool.strict;
      return { type: "function", function: fn };
    });
    body.tools = tools;
    const choice = request.toolChoice;
    if (choice !== undefined) {
      const converted: ChatCompletionToolChoiceOption =
        typeof choice === "string"
          ? choice
          : { type: "function", function: { name: choice.name } };
      body.tool_choice = converted;
    }
    if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls;
  }
  const reasoning = request.reasoning;
  if (reasoning) {
    if (reasoning.mode === "effort" && reasoning.effort) body.reasoning_effort = reasoning.effort;
    if (reasoning.mode === "budget" && reasoning.budget) body.thinking_budget = reasoning.budget;
    if (reasoning.mode === "off") body.reasoning_effort = "none";
  }
  if (request.responseFormat !== undefined) body.response_format = request.responseFormat;
  if (request.user) body.user = request.user;
  if (Object.keys(request.metadata).length > 0) body.metadata = request.metadata;
  if (request.stream) body.stream_options = { include_usage: true };
  return body;
}

export function finishFromChat(reason: unknown, hasToolCalls: boolean): IrFinishReason {
  switch (text(reason)) {
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return hasToolCalls ? "tool_calls" : "stop";
  }
}

export function finishToChat(reason: IrFinishReason): string {
  switch (reason) {
    case "length":
      return "length";
    case "tool_calls":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

export function decodeResponse(body: unknown, model: string): IrResponse {
  const data = record(body);
  const choices = array(data.choices);
  const choice = record(choices[0]);
  const message = record(choice.message);
  const content: IrContent[] = [];
  const reasoning = text(message.reasoning_content) || text(message.reasoning);
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  content.push(...contentParts(message.content));
  const toolCalls = toolCallsToIr(message);
  content.push(...toolCalls);
  const finishReason = finishFromChat(choice.finish_reason, toolCalls.length > 0);
  const usage = mergeUsage(emptyUsage(), fromChatUsage(data.usage));
  return {
    id: text(data.id),
    model: text(data.model) || model,
    content,
    finishReason,
    usage,
    status: finishReason === "length" ? "incomplete" : "completed",
    ...(finishReason === "length" ? { incompleteReason: "max_output_tokens" } : {}),
  };
}

export function encodeResponse(response: IrResponse): ChatCompletion {
  const converted = irContentToChat(response.content);
  const message: Mutable<ChatCompletion["choices"][number]["message"]> & { reasoning_content?: string } = {
    role: "assistant",
    content: converted.content as string | null,
    refusal: null,
  };
  if (converted.toolCalls.length > 0) message.tool_calls = converted.toolCalls;
  if (converted.reasoning) message.reasoning_content = converted.reasoning;
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: message as ChatCompletion["choices"][number]["message"],
        finish_reason: finishToChat(response.finishReason) as ChatCompletion["choices"][number]["finish_reason"],
      },
    ],
    usage: toChatUsage(response.usage) as ChatCompletion["usage"],
  };
}

export class ChatStreamDecoder {
  private current: IrUsage = emptyUsage();

  private finishReason: IrFinishReason = "stop";

  private readonly tools = new Map<number, { id: string; name: string }>();

  private started = false;

  constructor(private readonly model: string) {}

  decode(event: { event: string; data: string }): IrEvent[] {
    const parsed = parseJson(event.data);
    if (parsed === null) return [];
    const chunk = record(parsed);
    const out: IrEvent[] = [];
    this.current = mergeUsage(this.current, fromChatUsage(chunk.usage));
    if (!this.started) {
      this.started = true;
      out.push({ type: "start", id: text(chunk.id), model: text(chunk.model) || this.model });
    }
    const choices = array(chunk.choices);
    if (choices.length === 0) return out;
    const choice = record(choices[0]);
    const delta = record(choice.delta);
    const reasoning = text(delta.reasoning_content) || text(delta.reasoning);
    if (reasoning) out.push({ type: "reasoning_delta", text: reasoning });
    const content = text(delta.content);
    if (content) out.push({ type: "text_delta", text: content });
    for (const raw of array(delta.tool_calls)) {
      const call = record(raw);
      const index = number(call.index);
      const fn = record(call.function);
      let known = this.tools.get(index);
      if (!known) {
        known = { id: text(call.id), name: text(fn.name) };
        this.tools.set(index, known);
        out.push({ type: "tool_start", index, id: known.id, name: known.name });
      }
      const args = text(fn.arguments);
      if (args) out.push({ type: "tool_args_delta", index, json: args });
    }
    const finish = text(choice.finish_reason);
    if (finish) this.finishReason = finishFromChat(finish, this.tools.size > 0);
    return out;
  }

  finish(): IrEvent {
    return { type: "finish", reason: this.finishReason, usage: this.current };
  }

  usage(): IrUsage {
    return this.current;
  }

  reason(): IrFinishReason {
    return this.finishReason;
  }
}

export class ChatStreamEncoder {
  private sequence = 0;

  private readonly tools = new Map<number, { id: string; name: string }>();

  private readonly toolOrder: number[] = [];

  private id = "";

  private model = "";

  private usage: IrUsage = emptyUsage();

  private started = false;

  private includeReasoning = true;

  constructor(options?: { includeReasoning?: boolean }) {
    if (options?.includeReasoning === false) this.includeReasoning = false;
  }

  encode(event: IrEvent): Array<{ event: string; data: string }> {
    switch (event.type) {
      case "start":
        this.started = true;
        this.id = event.id;
        this.model = event.model;
        return [this.chunk({ role: "assistant", content: "" }, null)];
      case "reasoning_delta":
        if (!this.includeReasoning || !event.text) return [];
        return [this.chunk({ reasoning_content: event.text }, null)];
      case "text_delta":
        if (!event.text) return [];
        return [this.chunk({ content: event.text }, null)];
      case "tool_start": {
        this.tools.set(event.index, { id: event.id, name: event.name });
        this.toolOrder.push(event.index);
        return [
          this.chunk(
            {
              tool_calls: [
                {
                  index: event.index,
                  id: event.id,
                  type: "function",
                  function: { name: event.name, arguments: "" },
                },
              ],
            },
            null
          ),
        ];
      }
      case "tool_args_delta":
        if (!event.json) return [];
        return [
          this.chunk(
            { tool_calls: [{ index: event.index, function: { arguments: event.json } }] },
            null
          ),
        ];
      case "finish": {
        this.usage = event.usage;
        const reason = event.reason;
        const finish = finishToChat(reason);
        const usage = toChatUsage(event.usage);
        return [
          this.chunk({}, finish),
          {
            event: "",
            data: JSON.stringify({
              id: this.id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: this.model,
              choices: [],
              usage,
            }),
          },
          { event: "", data: "[DONE]" },
        ];
      }
      case "error":
        return [
          {
            event: "",
            data: JSON.stringify({ error: { message: event.error.message, type: event.error.type } }),
          },
        ];
      default:
        return [];
    }
  }

  private chunk(delta: Record<string, unknown>, finish: unknown): { event: string; data: string } {
    const payload = {
      id: this.id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    return { event: "", data: JSON.stringify(payload) };
  }

  state(): { id: string; model: string; usage: IrUsage; started: boolean } {
    return { id: this.id, model: this.model, usage: this.usage, started: this.started };
  }

  nextSequence(): number {
    const current = this.sequence;
    this.sequence += 1;
    return current;
  }
}
