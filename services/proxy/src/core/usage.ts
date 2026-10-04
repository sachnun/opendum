import { numberAsFloat, numberAsInt } from "./helpers.js";
import { SseScanner } from "./sse.js";
import type { UsageCounts } from "./types.js";

type Json = Record<string, unknown>;

export function emptyUsage(): UsageCounts {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
}

export function usageObject(parsed: Json): Json | null {
  const usage = parsed.usage;
  if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) return usage as Json;
  const response = parsed.response;
  if (response !== null && typeof response === "object" && !Array.isArray(response)) {
    const nested = (response as Json).usage;
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) return nested as Json;
  }
  return null;
}

export function usageCacheCounts(usage: Json): { cached: number; write: number } {
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Json;
  const inputDetails = (usage.input_tokens_details ?? {}) as Json;
  let cached = numberAsInt(promptDetails.cached_tokens);
  if (cached === 0) cached = numberAsInt(inputDetails.cached_tokens);
  let write = numberAsInt(promptDetails.cache_write_tokens);
  if (write === 0) write = numberAsInt(inputDetails.cache_write_tokens);
  if (cached === 0) cached = numberAsInt(usage.cache_read_input_tokens);
  if (write === 0) write = numberAsInt(usage.cache_creation_input_tokens);
  return { cached, write };
}

export function usageFromJson(parsed: Json): UsageCounts {
  const usage = usageObject(parsed);
  if (!usage) return emptyUsage();
  const counts = emptyUsage();
  let input = numberAsInt(usage.prompt_tokens);
  if (input === 0) input = numberAsInt(usage.input_tokens);
  let output = numberAsInt(usage.completion_tokens);
  if (output === 0) output = numberAsInt(usage.output_tokens);
  counts.inputTokens = input;
  counts.outputTokens = output;
  const { cached, write } = usageCacheCounts(usage);
  counts.cachedTokens = cached;
  counts.cacheWriteTokens = write;
  return counts;
}

export class OpenAIStreamUsageTracker {
  private readonly scanner = new SseScanner();
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  cacheWriteTokens = 0;
  hypercreditsRemaining: number | null = null;
  hypercreditsCost = 0;

  process(chunk: string): void {
    this.scanner.process(chunk, (event) => this.processEvent(event.data));
  }

  flush(): void {
    this.scanner.flush((event) => this.processEvent(event.data));
  }

  private processEvent(data: string): void {
    let parsed: Json;
    try {
      parsed = JSON.parse(data) as Json;
    } catch {
      return;
    }
    const usage = usageObject(parsed);
    if (!usage) return;
    let input = numberAsInt(usage.prompt_tokens);
    if (input === 0) input = numberAsInt(usage.input_tokens);
    if (input > 0) this.inputTokens = input;
    let output = numberAsInt(usage.completion_tokens);
    if (output === 0) output = numberAsInt(usage.output_tokens);
    if (output > 0) this.outputTokens = output;
    const { cached, write } = usageCacheCounts(usage);
    if (cached > 0) this.cachedTokens = cached;
    if (write > 0) this.cacheWriteTokens = write;
    const remaining = usage.remaining;
    if (remaining !== null && typeof remaining === "object" && !Array.isArray(remaining)) {
      const value = numberAsFloat((remaining as Json).hypercredits);
      if (value > 0) this.hypercreditsRemaining = value;
    }
    const cost = usage.cost;
    if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
      const value = numberAsFloat((cost as Json).hypercredits);
      if (value > 0) this.hypercreditsCost = value;
    }
  }
}
