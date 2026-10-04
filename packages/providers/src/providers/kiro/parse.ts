import { cloneAnyMap, stringValue } from "#providers/lib/helpers.ts";
import type { Json } from "#providers/providers/kiro/constants.ts";
import { kiroReasoningContent, kiroUsage } from "#providers/providers/kiro/helpers.ts";

export class KiroParserState {
  buffer = "";
}

export function nextKiroJsonStart(buffer: string, offset: number): number {
  const patterns = [
    '{"assistantResponseEvent":', '{"toolUseEvent":', '{"reasoningContentEvent":',
    '{"metadataEvent":', '{"messageMetadataEvent":', '{"tokenUsage":', '{"usage":',
    '{"content":', '{"name":', '{"followupPrompt":', '{"input":', '{"stop":',
    '{"contextUsagePercentage":', '{"type":"reasoningContentEvent"', '{"text":',
    '{"error":', '{"Error":', '{"message":',
  ];
  let best = -1;
  for (const pattern of patterns) {
    const idx = buffer.indexOf(pattern, offset);
    if (idx >= 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

export function keepKiroParserTail(value: string): string {
  return value.length <= 64 ? value : value.slice(value.length - 64);
}

export function normalizeKiroResponseEvents(event: Json): Json[] {
  const out: Json[] = [];
  for (const key of [
    "assistantResponseEvent", "toolUseEvent", "reasoningContentEvent", "metadataEvent",
    "messageMetadataEvent", "tokenUsage", "usage",
  ]) {
    const nested = event[key];
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      const copyEvent = cloneAnyMap(nested as Json);
      copyEvent.type = key;
      if (key === "reasoningContentEvent") copyEvent.reasoningContentEvent = nested;
      out.push(copyEvent);
    }
  }
  return out.length > 0 ? out : [event];
}

export function isKiroResponseEvent(parsed: Json): boolean {
  if (kiroReasoningContent(parsed)) return true;
  if (typeof parsed.content === "string" && parsed.followupPrompt === undefined) return true;
  if (stringValue(parsed.name) && stringValue(parsed.toolUseId)) return true;
  if (typeof parsed.input === "string") return true;
  if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) return true;
  if (parsed.contextUsagePercentage !== undefined) return true;
  if (kiroUsage(parsed)) return true;
  if (parsed.error !== undefined || parsed.Error !== undefined || parsed.message !== undefined) return true;
  return false;
}

export function parseKiroJsonEvents(source: string, state: KiroParserState): Json[] {
  state.buffer += source;
  const events: Json[] = [];
  let cursor = 0;
  while (cursor < state.buffer.length) {
    const start = nextKiroJsonStart(state.buffer, cursor);
    if (start === -1) {
      state.buffer = keepKiroParserTail(state.buffer.slice(cursor));
      return events;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < state.buffer.length; i += 1) {
      const ch = state.buffer[i];
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
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      state.buffer = state.buffer.slice(start);
      return events;
    }
    const candidate = state.buffer.slice(start, end + 1);
    cursor = end + 1;
    try {
      const parsed = JSON.parse(candidate) as Json;
      for (const event of normalizeKiroResponseEvents(parsed)) {
        if (isKiroResponseEvent(event)) events.push(event);
      }
    } catch {
      continue;
    }
  }
  state.buffer = "";
  return events;
}
