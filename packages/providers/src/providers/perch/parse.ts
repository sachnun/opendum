import { stringValue } from "#providers/lib/helpers.ts";

type Json = Record<string, unknown>;

export class PerchUpstreamError extends Error {
  readonly quota: boolean;
  constructor(message: string, quota: boolean) {
    super(message);
    this.name = "PerchUpstreamError";
    this.quota = quota;
  }
}

export function perchUsageToChatUsage(raw: unknown): Json | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Json;
  const int = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && value > 0 ? Math.trunc(value) : 0;
  };
  const input = int("inputTokens");
  const output = int("outputTokens");
  const cacheRead = int("cacheReadInputTokens");
  if (input === 0 && output === 0 && cacheRead === 0) return null;
  const promptTokens = input + cacheRead;
  const out: Json = {
    prompt_tokens: promptTokens,
    completion_tokens: output,
    total_tokens: promptTokens + output,
  };
  if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
  return out;
}

export function perchErrorMessage(event: Json): string {
  const text = stringValue(event.error);
  if (text) return text;
  if (event.error !== undefined && event.error !== null) return JSON.stringify(event.error);
  return "";
}

export function perchQuotaError(message: string): boolean {
  const lower = message.toLowerCase();
  return ["allowance", "quota", "limit", "usage", "billing", "credit"].some((marker) =>
    lower.includes(marker)
  );
}

export function perchEventToolCalls(event: Json): unknown[] {
  if (Array.isArray(event.toolCalls)) return event.toolCalls;
  if (Array.isArray(event.tool_calls)) return event.tool_calls;
  return [];
}

export function perchToolSealedArguments(call: Json): string {
  const text = stringValue(call.arguments);
  if (text) return text;
  if (call.arguments !== undefined && call.arguments !== null) return JSON.stringify(call.arguments);
  return "";
}

export function perchToolArgumentsDelta(call: Json, sealed: boolean): string {
  const raw = stringValue(call.rawArgumentsText);
  if (raw) return raw;
  if (sealed) return perchToolSealedArguments(call);
  return "";
}
