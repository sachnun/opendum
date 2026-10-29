import { Result } from "effect";
import { Coerce, Safe } from "@opendum/api/proxy/helpers";
import { SseScanner } from "@opendum/api/proxy/sse";
import type { UsageCounts } from "@opendum/api/proxy/types";

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

export function cacheCounts(usage: Json): { cached: number; write: number } {
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Json;
  const inputDetails = (usage.input_tokens_details ?? {}) as Json;
  let cached = Coerce.int(promptDetails.cached_tokens);
  if (cached === 0) cached = Coerce.int(inputDetails.cached_tokens);
  let write = Coerce.int(promptDetails.cache_write_tokens);
  if (write === 0) write = Coerce.int(inputDetails.cache_write_tokens);
  if (cached === 0) cached = Coerce.int(usage.cache_read_input_tokens);
  if (write === 0) write = Coerce.int(usage.cache_creation_input_tokens);
  return { cached, write };
}

export function usageOf(parsed: Json): UsageCounts {
  const usage = usageObject(parsed);
  if (!usage) return emptyUsage();
  const counts = emptyUsage();
  let input = Coerce.int(usage.prompt_tokens);
  if (input === 0) input = Coerce.int(usage.input_tokens);
  let output = Coerce.int(usage.completion_tokens);
  if (output === 0) output = Coerce.int(usage.output_tokens);
  counts.inputTokens = input;
  counts.outputTokens = output;
  const { cached, write } = cacheCounts(usage);
  counts.cachedTokens = cached;
  counts.cacheWriteTokens = write;
  return counts;
}

export class StreamUsageTracker {
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
    const parsedData = Safe.json(data);
    if (Result.isFailure(parsedData)) return;
    const parsed = parsedData.success as Json;
    const usage = usageObject(parsed);
    if (!usage) return;
    let input = Coerce.int(usage.prompt_tokens);
    if (input === 0) input = Coerce.int(usage.input_tokens);
    if (input > 0) this.inputTokens = input;
    let output = Coerce.int(usage.completion_tokens);
    if (output === 0) output = Coerce.int(usage.output_tokens);
    if (output > 0) this.outputTokens = output;
    const { cached, write } = cacheCounts(usage);
    if (cached > 0) this.cachedTokens = cached;
    if (write > 0) this.cacheWriteTokens = write;
    const remaining = usage.remaining;
    if (remaining !== null && typeof remaining === "object" && !Array.isArray(remaining)) {
      const value = Coerce.float((remaining as Json).hypercredits);
      if (value > 0) this.hypercreditsRemaining = value;
    }
    const cost = usage.cost;
    if (cost !== null && typeof cost === "object" && !Array.isArray(cost)) {
      const value = Coerce.float((cost as Json).hypercredits);
      if (value > 0) this.hypercreditsCost = value;
    }
  }
}
