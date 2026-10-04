import {
  cloneAnyMap,
  contentToText,
  defaultStringValue,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import type { Json } from "#providers/providers/kiro/constants.ts";
import { defaultAny, joinNonEmpty, kiroTruncate } from "#providers/providers/kiro/helpers.ts";

export function convertKiroTools(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    const tool = (item ?? {}) as Json;
    let fn = (tool.function ?? {}) as Json;
    let name = stringValue(fn.name).trim();
    if (!name) {
      name = stringValue(tool.name).trim();
      fn = tool;
    }
    if (!name) continue;
    const paramsValue = defaultAny(fn.parameters, fn.input_schema);
    const params =
      paramsValue !== null && typeof paramsValue === "object" && !Array.isArray(paramsValue)
        ? (paramsValue as Json)
        : { type: "object", properties: {} };
    result.push({
      toolSpecification: {
        name,
        description: kiroTruncate(defaultStringValue(fn.description, ""), 9216),
        inputSchema: { json: params },
      },
    });
  }
  return result;
}

export function splitKiroSystemMessages(rawMessages: unknown[]): { systemPrompt: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  for (const raw of rawMessages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "system" || role === "developer") {
      const text = contentToText(msg.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    messages.push(raw);
  }
  return { systemPrompt: systemParts.join("\n\n"), messages };
}

export function mergeKiroContent(a: unknown, b: unknown): unknown {
  const aParts = Array.isArray(a) ? a : null;
  const bParts = Array.isArray(b) ? b : null;
  if (aParts && bParts) return [...aParts, ...bParts];
  if (aParts) {
    const text = stringValue(b);
    return text ? [...aParts, { type: "text", text }] : a;
  }
  if (bParts) {
    const text = stringValue(a);
    return text ? [{ type: "text", text }, ...bParts] : b;
  }
  return joinNonEmpty("\n", contentToText(a), contentToText(b));
}

export function normalizeKiroToolMessages(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  let pendingToolResults: unknown[] = [];
  const flushPending = (): void => {
    if (pendingToolResults.length === 0) return;
    normalized.push({ role: "user", content: pendingToolResults });
    pendingToolResults = [];
  };
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_call_id: defaultStringValue(msg.tool_call_id, randomId("toolu")),
        content: msg.content,
      });
      continue;
    }
    if (role === "assistant") {
      flushPending();
      normalized.push(raw);
      continue;
    }
    if (role === "user" && pendingToolResults.length > 0) {
      const copyMsg = cloneAnyMap(msg);
      copyMsg.content = mergeKiroContent(pendingToolResults, msg.content);
      normalized.push(copyMsg);
      pendingToolResults = [];
      continue;
    }
    normalized.push(raw);
  }
  flushPending();
  return normalized;
}

export function mergeAdjacentKiroMessages(messages: unknown[]): unknown[] {
  const merged: Json[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (merged.length > 0 && role !== "tool") {
      const last = merged[merged.length - 1];
      if (stringValue(last.role) === role) {
        last.content = mergeKiroContent(last.content, msg.content);
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          const existing = Array.isArray(last.tool_calls) ? (last.tool_calls as unknown[]) : [];
          last.tool_calls = [...existing, ...(msg.tool_calls as unknown[])];
        }
        continue;
      }
    }
    merged.push(cloneAnyMap(msg));
  }
  return merged;
}
