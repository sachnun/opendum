import { Schema } from "effect";
import { emptyUsage, type IrUsage } from "@opendum/protocol/ir";

function int(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export const ChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  prompt_tokens_details: Schema.optional(Schema.Unknown),
  completion_tokens_details: Schema.optional(Schema.Unknown),
});

export const ResponsesUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  input_tokens_details: Schema.optional(Schema.Unknown),
  output_tokens_details: Schema.optional(Schema.Unknown),
});

export const AnthropicUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
});

export type ChatUsage = typeof ChatUsage.Type;
export type ResponsesUsage = typeof ResponsesUsage.Type;
export type AnthropicUsage = typeof AnthropicUsage.Type;

export function fromChatUsage(value: unknown): IrUsage {
  const usage = record(value);
  const prompt = record(usage.prompt_tokens_details);
  const completion = record(usage.completion_tokens_details);
  const input = int(usage.prompt_tokens);
  const output = int(usage.completion_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: int(prompt.cached_tokens),
    cacheWriteTokens: int(prompt.cache_write_tokens),
    reasoningTokens: int(completion.reasoning_tokens),
  };
}

export function fromResponsesUsage(value: unknown): IrUsage {
  const usage = record(value);
  const inputDetails = record(usage.input_tokens_details);
  const outputDetails = record(usage.output_tokens_details);
  return {
    inputTokens: int(usage.input_tokens),
    outputTokens: int(usage.output_tokens),
    cachedTokens: int(inputDetails.cached_tokens),
    cacheWriteTokens: int(inputDetails.cache_write_tokens),
    reasoningTokens: int(outputDetails.reasoning_tokens),
  };
}

export function fromAnthropicUsage(value: unknown): IrUsage {
  const usage = record(value);
  return {
    inputTokens: int(usage.input_tokens),
    outputTokens: int(usage.output_tokens),
    cachedTokens: int(usage.cache_read_input_tokens),
    cacheWriteTokens: int(usage.cache_creation_input_tokens),
    reasoningTokens: 0,
  };
}

export function mergeUsage(base: IrUsage, next: Partial<IrUsage>): IrUsage {
  const merged = { ...base };
  if (next.inputTokens !== undefined && next.inputTokens > 0) merged.inputTokens = next.inputTokens;
  if (next.outputTokens !== undefined && next.outputTokens > 0) merged.outputTokens = next.outputTokens;
  if (next.cachedTokens !== undefined && next.cachedTokens > 0) merged.cachedTokens = next.cachedTokens;
  if (next.cacheWriteTokens !== undefined && next.cacheWriteTokens > 0) {
    merged.cacheWriteTokens = next.cacheWriteTokens;
  }
  if (next.reasoningTokens !== undefined && next.reasoningTokens > 0) {
    merged.reasoningTokens = next.reasoningTokens;
  }
  return merged;
}

export function toChatUsage(usage: IrUsage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
  if (usage.cachedTokens > 0 || usage.cacheWriteTokens > 0) {
    out.prompt_tokens_details = {
      cached_tokens: usage.cachedTokens,
      cache_write_tokens: usage.cacheWriteTokens,
    };
  }
  if (usage.reasoningTokens > 0) {
    out.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
  }
  return out;
}

export function toResponsesUsage(usage: IrUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedTokens,
      cache_write_tokens: usage.cacheWriteTokens,
    },
    output_tokens: usage.outputTokens,
    output_tokens_details: { reasoning_tokens: usage.reasoningTokens },
    total_tokens: usage.inputTokens + usage.outputTokens,
  };
}

export function toAnthropicUsage(usage: IrUsage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedTokens > 0) out.cache_read_input_tokens = usage.cachedTokens;
  if (usage.cacheWriteTokens > 0) out.cache_creation_input_tokens = usage.cacheWriteTokens;
  return out;
}

export function usageRecord(value: unknown): Record<string, unknown> | null {
  const usage = record(value).usage;
  if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
    return usage as Record<string, unknown>;
  }
  const nested = record(record(value).response).usage;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return null;
}

export function usageFromUnknown(value: unknown): IrUsage {
  const usage = usageRecord(value);
  if (!usage) return emptyUsage();
  const chat = fromChatUsage(usage);
  if (chat.inputTokens > 0 || chat.outputTokens > 0) return chat;
  const responses = fromResponsesUsage(usage);
  if (responses.inputTokens > 0 || responses.outputTokens > 0) return responses;
  return fromAnthropicUsage(usage);
}
