import type { ResponseContext, StreamWriter } from "./types.js";
import { SSEScanner } from "../providers/model_helpers.js";
import { readAllText } from "../providers/http.js";

export interface UsageTrackerCallbacks {
  recordSuccess: (params: { inputTokens: number; outputTokens: number; durationMS: number }) => void;
}

class OpenAIStreamUsageTracker {
  private scanner = new SSEScanner();
  inputTokens = 0;
  outputTokens = 0;

  process(chunk: string): void {
    this.scanner.process(chunk, (event) => this.processEvent(event));
  }

  flush(): void {
    this.scanner.flush((event) => this.processEvent(event));
  }

  private processEvent(event: { data: string }): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = parsed["usage"];
    if (!usage || typeof usage !== "object") return;
    const u = usage as Record<string, unknown>;
    const input = numberAsInt(u["prompt_tokens"]);
    if (input > 0) {
      this.inputTokens = input;
    } else {
      const input2 = numberAsInt(u["input_tokens"]);
      if (input2 > 0) this.inputTokens = input2;
    }
    const output = numberAsInt(u["completion_tokens"]);
    if (output > 0) {
      this.outputTokens = output;
    } else {
      const output2 = numberAsInt(u["output_tokens"]);
      if (output2 > 0) this.outputTokens = output2;
    }
  }
}

export async function passthroughStream(ctx: ResponseContext, callbacks: UsageTrackerCallbacks): Promise<void> {
  const writer = ctx.writer;
  writer.header("content-type", "text/event-stream");
  writer.header("cache-control", "no-cache");
  writer.header("connection", "keep-alive");
  writer.header("x-accel-buffering", "no");
  writer.header("x-provider-account-id", ctx.accountId);

  const tracker = new OpenAIStreamUsageTracker();
  const reader = ctx.response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      tracker.process(chunk);
      await writer.write(value);
      if (writer.flush) writer.flush();
    }
  }
  tracker.flush();
  const durationMS = Date.now() - ctx.startMS;
  callbacks.recordSuccess({ inputTokens: tracker.inputTokens, outputTokens: tracker.outputTokens, durationMS });
}

export async function passthroughNonStream(ctx: ResponseContext, callbacks: UsageTrackerCallbacks): Promise<void> {
  const text = await readAllText(ctx.response.body);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // keep empty
  }
  const [inputTokens, outputTokens] = usageFromJSON(parsed);
  writerHeaders(ctx);
  await ctx.writer.write(text);
  const durationMS = Date.now() - ctx.startMS;
  callbacks.recordSuccess({ inputTokens, outputTokens, durationMS });
}

function writerHeaders(ctx: ResponseContext): void {
  ctx.writer.header("content-type", "application/json");
  ctx.writer.header("x-provider-account-id", ctx.accountId);
}

export function usageFromJSON(parsed: Record<string, unknown>): [number, number] {
  const usage = parsed["usage"];
  if (!usage || typeof usage !== "object") return [0, 0];
  const u = usage as Record<string, unknown>;
  let input = numberAsInt(u["prompt_tokens"]);
  if (input === 0) input = numberAsInt(u["input_tokens"]);
  let output = numberAsInt(u["completion_tokens"]);
  if (output === 0) output = numberAsInt(u["output_tokens"]);
  return [input, output];
}

export function numberAsInt(value: unknown): number {
  if (typeof value === "number") return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
