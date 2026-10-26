import { Value, Payload } from "../../core/helpers.js";
import { pick } from "./common.js";
import { KiroModel } from "./model.js";

export type Json = Record<string, unknown>;

export class KiroUsage {
  private static firstNumber(values: Json, keys: string[]): number {
    for (const key of keys) {
      const value = Value.number(values[key]);
      if (value > 0) return value;
    }
    return 0;
  }

  static fromEvent(event: Json): Json | null {
    let usage: Json | null = null;
    for (const key of ["usage", "tokenUsage"]) {
      const value = event[key];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) usage = value as Json;
    }
    if (!usage && event.type === "tokenUsage") usage = event;
    if (!usage) return null;
    const input = KiroUsage.firstNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
    const output = KiroUsage.firstNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
    if (input <= 0 && output <= 0) return null;
    return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  }

  static fromContext(model: string, contextUsagePercentage: number, outputText: string): Json {
    const outputTokens = KiroModel.estimateTokens(outputText);
    let inputTokens = 0;
    if (contextUsagePercentage > 0) {
      const totalTokens = Math.round((KiroModel.windowSize(model) * contextUsagePercentage) / 100);
      inputTokens = Math.max(0, totalTokens - outputTokens);
    }
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    };
  }

  static reasoningText(event: Json): string {
    const nested = event.reasoningContentEvent;
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      return Value.stringOr(
        (nested as Json).text,
        Value.string((nested as Json).reasoning_content)
      );
    }
    const text = Value.string(event.text);
    if (
      text &&
      (event.signature !== undefined ||
        event.redactedContent !== undefined ||
        event.redacted_content !== undefined ||
        event.type === "reasoningContentEvent")
    ) {
      return text;
    }
    return "";
  }

  static float(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  static errorMessage(event: Json): string {
    const message = Value.string(event.message);
    if (message && (event.error !== undefined || event.Error !== undefined)) return message;
    return Value.stringOr(event.error, Value.string(event.Error));
  }
}

export class KiroEvents {
  private static readonly START_MARKERS = [
    '{"assistantResponseEvent":', '{"toolUseEvent":', '{"reasoningContentEvent":',
    '{"metadataEvent":', '{"messageMetadataEvent":', '{"tokenUsage":', '{"usage":',
    '{"content":', '{"name":', '{"followupPrompt":', '{"input":', '{"stop":',
    '{"contextUsagePercentage":', '{"type":"reasoningContentEvent"', '{"text":',
    '{"error":', '{"Error":', '{"message":',
  ];

  static nextStart(buffer: string, offset: number): number {
    let best = -1;
    for (const marker of KiroEvents.START_MARKERS) {
      const idx = buffer.indexOf(marker, offset);
      if (idx >= 0 && (best === -1 || idx < best)) best = idx;
    }
    return best;
  }

  static tail(value: string): string {
    return value.length <= 64 ? value : value.slice(value.length - 64);
  }

  static expand(event: Json): Json[] {
    const out: Json[] = [];
    for (const key of [
      "assistantResponseEvent", "toolUseEvent", "reasoningContentEvent", "metadataEvent",
      "messageMetadataEvent", "tokenUsage", "usage",
    ]) {
      const nested = event[key];
      if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
        const copyEvent = Payload.clone(nested as Json);
        copyEvent.type = key;
        if (key === "reasoningContentEvent") copyEvent.reasoningContentEvent = nested;
        out.push(copyEvent);
      }
    }
    return out.length > 0 ? out : [event];
  }

  static relevant(parsed: Json): boolean {
    if (KiroUsage.reasoningText(parsed)) return true;
    if (typeof parsed.content === "string" && parsed.followupPrompt === undefined) return true;
    if (Value.string(parsed.name) && Value.string(parsed.toolUseId)) return true;
    if (typeof parsed.input === "string") return true;
    if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) return true;
    if (parsed.contextUsagePercentage !== undefined) return true;
    if (KiroUsage.fromEvent(parsed)) return true;
    if (parsed.error !== undefined || parsed.Error !== undefined || parsed.message !== undefined) return true;
    return false;
  }
}

export class KiroBracket {
  static balancedEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }
}

export { pick };
