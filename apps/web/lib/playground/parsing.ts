import type {
  ParsedCompletionData,
  ParsedUsageData,
  ResponseMetrics,
  ScenarioMessage,
  ToolCallData,
} from "~~/lib/playground/types";

export class Content {
  static text(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }

  static message(content: ScenarioMessage["content"]): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const type = (part as { type?: unknown }).type;
        if (type === "text") {
          const text = (part as { text?: unknown }).text;
          return typeof text === "string" ? text : "";
        }
        if (type === "image_url") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  static images(content: ScenarioMessage["content"]): string[] {
    if (typeof content === "string" || !Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "image_url") {
        return [];
      }
      const imageUrl = (part as { image_url?: unknown }).image_url;
      if (typeof imageUrl === "string") return [imageUrl];
      if (imageUrl && typeof imageUrl === "object" && typeof (imageUrl as { url?: unknown }).url === "string") {
        return [(imageUrl as { url: string }).url];
      }
      return [];
    });
  }
}

export class Tokens {
  static value(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : null;
  }

  static usage(payload: unknown): ParsedUsageData | null {
    if (!payload || typeof payload !== "object") return null;
    const usage = (payload as { usage?: unknown }).usage;
    if (!usage || typeof usage !== "object") return null;
    const record = usage as {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
      input_tokens?: unknown;
      output_tokens?: unknown;
    };
    const inputTokens = Tokens.value(record.prompt_tokens) ?? Tokens.value(record.input_tokens);
    const outputTokens = Tokens.value(record.completion_tokens) ?? Tokens.value(record.output_tokens);
    const totalTokens = Tokens.value(record.total_tokens);
    if (inputTokens === null && outputTokens === null && totalTokens === null) return null;
    return { inputTokens, outputTokens, totalTokens };
  }

  static merge(current: ParsedUsageData | null, incoming: ParsedUsageData | null): ParsedUsageData | null {
    if (!incoming) return current;
    return {
      inputTokens: incoming.inputTokens ?? current?.inputTokens ?? null,
      outputTokens: incoming.outputTokens ?? current?.outputTokens ?? null,
      totalTokens: incoming.totalTokens ?? current?.totalTokens ?? null,
    };
  }

  static metrics(
    waitMs: number | null,
    firstResponseMs: number | null,
    usage: ParsedUsageData | null
  ): ResponseMetrics {
    const inputTokens = usage?.inputTokens ?? null;
    const outputTokens = usage?.outputTokens ?? null;
    const totalTokens =
      usage?.totalTokens ??
      (inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0));
    return { waitMs, firstResponseMs, inputTokens, outputTokens, totalTokens };
  }
}

export class ToolCalls {
  static extract(toolCalls: unknown): ToolCallData[] {
    if (!Array.isArray(toolCalls)) return [];
    return toolCalls.map((toolCall, index) => {
      const fallback = { name: `tool_${index + 1}`, arguments: "{}" };
      if (!toolCall || typeof toolCall !== "object") return fallback;
      const fn = (toolCall as { function?: unknown }).function;
      if (!fn || typeof fn !== "object") return fallback;
      const name =
        typeof (fn as { name?: unknown }).name === "string"
          ? (fn as { name: string }).name || `tool_${index + 1}`
          : `tool_${index + 1}`;
      const args = (fn as { arguments?: unknown }).arguments;
      return {
        name,
        arguments:
          typeof args === "string" ? args.trim() || "{}" : args === undefined ? "{}" : JSON.stringify(args),
      };
    });
  }

  static anthropic(content: unknown): ToolCallData[] {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block, index) => {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_use") {
        return [];
      }
      const name =
        typeof (block as { name?: unknown }).name === "string"
          ? (block as { name: string }).name || `tool_${index + 1}`
          : `tool_${index + 1}`;
      const input = (block as { input?: unknown }).input;
      return [
        {
          name,
          arguments:
            typeof input === "string"
              ? input.trim() || "{}"
              : input === undefined
                ? "{}"
                : JSON.stringify(input),
        },
      ];
    });
  }

  static format(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
}

const empty = (usage: ParsedUsageData | null = null): ParsedCompletionData => ({
  content: "",
  reasoning: "",
  toolCalls: [],
  usage,
});

export class Completion {
  static error(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const error = (payload as { error?: unknown }).error;
    if (!error || typeof error !== "object") return null;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.trim() ? message : null;
  }

  static chat(payload: unknown): ParsedCompletionData {
    const usage = Tokens.usage(payload);
    if (!payload || typeof payload !== "object") return empty(usage);
    const choices = (payload as { choices?: unknown }).choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : null;
    const message =
      firstChoice && typeof firstChoice === "object"
        ? (firstChoice as { message?: unknown }).message
        : null;
    if (!message || typeof message !== "object") return empty(usage);
    return {
      content: Content.text((message as { content?: unknown }).content),
      reasoning: Content.text((message as { reasoning_content?: unknown }).reasoning_content),
      toolCalls: ToolCalls.extract((message as { tool_calls?: unknown }).tool_calls),
      usage,
    };
  }

  static streamChunk(payload: unknown): ParsedCompletionData {
    const usage = Tokens.usage(payload);
    if (!payload || typeof payload !== "object") return empty(usage);
    const choices = (payload as { choices?: unknown }).choices;
    const firstChoice = Array.isArray(choices) ? choices[0] : null;
    const delta =
      firstChoice && typeof firstChoice === "object"
        ? (firstChoice as { delta?: unknown }).delta
        : null;
    if (!delta || typeof delta !== "object") return empty(usage);
    const reasoning =
      (delta as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content ??
      (delta as { reasoning?: unknown }).reasoning;
    return {
      content: Content.text((delta as { content?: unknown }).content),
      reasoning: Content.text(reasoning),
      toolCalls: [],
      usage,
    };
  }

  static anthropic(payload: unknown): ParsedCompletionData {
    const usage = Tokens.usage(payload);
    if (!payload || typeof payload !== "object") return empty(usage);
    const blocks = (payload as { content?: unknown }).content;
    if (!Array.isArray(blocks)) return empty(usage);
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if ((block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
        textParts.push((block as { text: string }).text);
      }
      if (
        (block as { type?: unknown }).type === "thinking" &&
        typeof (block as { thinking?: unknown }).thinking === "string"
      ) {
        reasoningParts.push((block as { thinking: string }).thinking);
      }
    }
    return {
      content: textParts.join(""),
      reasoning: reasoningParts.join(""),
      toolCalls: ToolCalls.anthropic(blocks),
      usage,
    };
  }

  static responses(payload: unknown): ParsedCompletionData {
    const usage =
      Tokens.usage(payload) ??
      (payload && typeof payload === "object"
        ? Tokens.usage({ usage: ((payload as { response?: { usage?: unknown } }).response)?.usage })
        : null);
    if (!payload || typeof payload !== "object") return empty(usage);
    const outputItems = (payload as { output?: unknown }).output;
    if (!Array.isArray(outputItems)) return Completion.chat(payload);

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCallData[] = [];
    for (const item of outputItems) {
      if (!item || typeof item !== "object") continue;
      const itemType = (item as { type?: unknown }).type;
      if (itemType === "message") {
        const content = (item as { content?: unknown }).content;
        if (typeof content === "string") textParts.push(content);
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === "object" &&
              ["output_text", "text", "input_text"].includes(String((part as { type?: unknown }).type)) &&
              typeof (part as { text?: unknown }).text === "string"
            ) {
              textParts.push((part as { text: string }).text);
            }
          }
        }
      }
      if (itemType === "reasoning") {
        const summary = (item as { summary?: unknown }).summary;
        if (Array.isArray(summary)) {
          for (const part of summary) {
            if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
              reasoningParts.push((part as { text: string }).text);
            }
          }
        }
      }
      if (itemType === "function_call" && typeof (item as { name?: unknown }).name === "string") {
        const args = (item as { arguments?: unknown }).arguments;
        toolCalls.push({
          name: (item as { name: string }).name,
          arguments:
            typeof args === "string" ? args.trim() || "{}" : args === undefined ? "{}" : JSON.stringify(args),
        });
      }
    }
    return { content: textParts.join(""), reasoning: reasoningParts.join(""), toolCalls, usage };
  }

  static anthropicStream(eventName: string, payload: unknown): ParsedCompletionData {
    if (!payload || typeof payload !== "object") return empty();
    const normalizedEventName =
      eventName ||
      (typeof (payload as { type?: unknown }).type === "string"
        ? (payload as { type: string }).type
        : "");
    if (normalizedEventName === "content_block_delta") {
      const delta = (payload as { delta?: unknown }).delta;
      if (!delta || typeof delta !== "object") return empty();
      if ((delta as { type?: unknown }).type === "text_delta") {
        return {
          content:
            typeof (delta as { text?: unknown }).text === "string"
              ? (delta as { text: string }).text
              : "",
          reasoning: "",
          toolCalls: [],
          usage: null,
        };
      }
      if ((delta as { type?: unknown }).type === "thinking_delta") {
        return {
          content: "",
          reasoning:
            typeof (delta as { thinking?: unknown }).thinking === "string"
              ? (delta as { thinking: string }).thinking
              : "",
          toolCalls: [],
          usage: null,
        };
      }
    }
    if (normalizedEventName === "message_delta") {
      return {
        content: "",
        reasoning: "",
        toolCalls: [],
        usage: Tokens.usage({ usage: (payload as { usage?: unknown }).usage }),
      };
    }
    return empty();
  }

  static responsesStream(payload: unknown): ParsedCompletionData {
    if (!payload || typeof payload !== "object") return empty();
    const type = (payload as { type?: unknown }).type;
    if (typeof type !== "string") return Completion.streamChunk(payload);
    const delta = (payload as { delta?: unknown; text?: unknown }).delta;
    const text = (payload as { delta?: unknown; text?: unknown }).text;
    if (type.includes("output_text")) {
      return {
        content: typeof delta === "string" ? delta : typeof text === "string" ? text : "",
        reasoning: "",
        toolCalls: [],
        usage: null,
      };
    }
    if (type.includes("reasoning")) {
      return {
        content: "",
        reasoning: typeof delta === "string" ? delta : typeof text === "string" ? text : "",
        toolCalls: [],
        usage: null,
      };
    }
    if (type === "response.completed") {
      return { content: "", reasoning: "", toolCalls: [], usage: Tokens.usage(payload) };
    }
    return empty();
  }
}
