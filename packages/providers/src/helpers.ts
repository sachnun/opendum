import { randomBytes } from "node:crypto";

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function defaultStringValue(value: unknown, fallback: string): string {
  const str = stringValue(value);
  return str !== "" ? str : fallback;
}

export function defaultEmpty(value: string, fallback: string): string {
  return value !== "" ? value : fallback;
}

export function numberFromAny(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

export function boolFromAny(value: unknown): boolean {
  return value === true;
}

export function cloneAnyMap(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      out[key] = cloneAnyMap(value as Record<string, unknown>);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function stringSlice(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const str = stringValue(item);
    if (str !== "") out.push(str);
  }
  return out;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const item = content as Record<string, unknown>;
    for (const key of ["text", "input_text", "output_text"]) {
      const value = stringValue(item[key]);
      if (value) return value;
    }
    if (item.content !== undefined) return contentToText(item.content);
  }
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const raw of content) {
      const part = raw as Record<string, unknown>;
      for (const key of ["text", "input_text", "output_text"]) {
        const value = stringValue(part[key]);
        if (value) {
          chunks.push(value);
          break;
        }
      }
      if (part.type === "tool_result" && part.content !== undefined) {
        chunks.push(contentToText(part.content));
      }
    }
    return chunks.join("");
  }
  return "";
}

export function normalizeToolChoice(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const choice = value as Record<string, unknown>;
  if (choice.type !== "function") return value;
  const fn = (choice.function ?? {}) as Record<string, unknown>;
  const name = stringValue(fn.name) || stringValue(choice.name);
  if (!name) return value;
  return { type: "function", name };
}

export function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function isTruthful(value: unknown): boolean {
  return value === true;
}

export function filterKeys(
  input: Record<string, unknown>,
  supported: Set<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (supported.has(key) && value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

export function extractInstructions(messages: unknown[]): string {
  const parts: string[] = [];
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg.role);
    if (role !== "system" && role !== "developer") continue;
    const text = contentToText(msg.content).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export function parseSseDataLines(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }
  return events;
}
