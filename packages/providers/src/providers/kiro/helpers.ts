import { defaultStringValue, numberFromAny, stringValue } from "#providers/lib/helpers.ts";
import { KIRO_REGION } from "#providers/api/endpoints.ts";
import type { Registry } from "@opendum/models/runtime";
import type { ProviderAccount } from "#providers/model/types.ts";
import { KIRO_API_BASE_URL, type Json } from "#providers/providers/kiro/constants.ts";

export function lastModelSegment(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1];
}

export function defaultAny(value: unknown, fallback: unknown): unknown {
  return value !== undefined && value !== null ? value : fallback;
}

export function defaultThinkingBudget(effort: string): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 10000;
    case "high":
    case "xhigh":
      return 32000;
    default:
      return 0;
  }
}

export function joinNonEmpty(sep: string, ...values: string[]): string {
  return values.filter((value) => value.trim() !== "").join(sep);
}

export function kiroTruncate(value: string, maxLen: number): string {
  if (maxLen <= 0 || value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

export function normalizeKiroTier(rawType: string, subscriptionTitle: string): string {
  switch (rawType.trim().toUpperCase()) {
    case "Q_DEVELOPER_STANDALONE_FREE":
      return "free";
    case "Q_DEVELOPER_STANDALONE_POWER":
      return "power";
    case "Q_DEVELOPER_STANDALONE_PRO":
      return "pro";
    case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
      return "pro-plus";
    case "Q_DEVELOPER_STANDALONE":
      return "standalone";
    default:
      break;
  }
  const title = subscriptionTitle.trim().toLowerCase();
  if (!title) return "";
  if (title.includes("pro+") || title.includes("pro plus")) return "pro-plus";
  if (title.includes("power")) return "power";
  if (title.includes("pro")) return "pro";
  if (title.includes("free")) return "free";
  return title.replace(/[_-]/g, " ").trim().split(/\s+/).join("-");
}

export function kiroRegionFromArn(arn: string): string {
  const parts = arn.trim().split(":");
  if (parts.length >= 4 && parts[0] === "arn" && parts[3]) return parts[3];
  return "";
}

export function kiroApiUrlForAccount(account: ProviderAccount): string {
  let region = KIRO_REGION;
  if (account.accountId) {
    const extracted = kiroRegionFromArn(account.accountId);
    if (extracted) region = extracted;
  }
  return KIRO_API_BASE_URL.replace("%s", region);
}

export function kiroNumberAsFloat(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function kiroContextWindowSize(model: string): number {
  return model.includes("-1m") ? 1_000_000 : 200_000;
}

export function estimateKiroTokens(text: string): number {
  if (!text) return 0;
  return Math.floor((text.length + 3) / 4);
}

export function kiroUsageFromContext(model: string, contextUsagePercentage: number, outputText: string): Json {
  const outputTokens = estimateKiroTokens(outputText);
  let inputTokens = 0;
  if (contextUsagePercentage > 0) {
    const totalTokens = Math.round((kiroContextWindowSize(model) * contextUsagePercentage) / 100);
    inputTokens = Math.max(0, totalTokens - outputTokens);
  }
  return { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens };
}

export function kiroReasoningContent(event: Json): string {
  const nested = event.reasoningContentEvent;
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return defaultStringValue((nested as Json).text, stringValue((nested as Json).reasoning_content));
  }
  const text = stringValue(event.text);
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

export function firstKiroNumber(values: Json, keys: string[]): number {
  for (const key of keys) {
    const value = numberFromAny(values[key]);
    if (value > 0) return value;
  }
  return 0;
}

export function kiroUsage(event: Json): Json | null {
  let usage: Json | null = null;
  for (const key of ["usage", "tokenUsage"]) {
    const value = event[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) usage = value as Json;
  }
  if (!usage && event.type === "tokenUsage") usage = event;
  if (!usage) return null;
  const input = firstKiroNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const output = firstKiroNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  if (input <= 0 && output <= 0) return null;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

export function kiroErrorMessage(event: Json): string {
  const message = stringValue(event.message);
  if (message && (event.error !== undefined || event.Error !== undefined)) return message;
  return defaultStringValue(event.error, stringValue(event.Error));
}

export function normalizeKiroModel(registry: Registry, model: string): string {
  const raw = lastModelSegment(model);
  if (registry.isSupportedByProvider(raw, "kiro")) return registry.upstreamModelName(raw, "kiro");
  if (raw.endsWith("-thinking")) {
    const base = raw.slice(0, -"-thinking".length);
    if (registry.isSupportedByProvider(base, "kiro")) return registry.upstreamModelName(base, "kiro");
  }
  return registry.upstreamModelName(raw, "kiro");
}
