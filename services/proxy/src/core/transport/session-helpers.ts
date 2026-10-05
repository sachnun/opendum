import { createHash } from "node:crypto";

import { stringValue } from "./helpers.ts";

export function extractSessionId(request: Request, body: Record<string, unknown>): string {
  for (const header of [
    "x-claude-code-session-id",
    "session_id",
    "x-session-id",
    "session-id",
    "x-session-affinity",
    "x-client-request-id",
  ]) {
    const value = request.headers.get(header)?.trim();
    if (value) return value;
  }
  for (const key of ["prompt_cache_key", "session_id", "sessionId", "conversation_id"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const metadata = body.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.trim()) {
      const match = /_session_([a-f0-9-]+)$/.exec(userId);
      if (match) return `claude:${match[1]}`;
      return userId.trim();
    }
  }
  const text = firstUserText(body);
  if (text && text.trim().length > 20) {
    const trimmed = text.trim().slice(0, 100);
    return `prompt:${createHash("sha256").update(trimmed).digest("hex").slice(0, 16)}`;
  }
  return "";
}

export function firstUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const raw of messages) {
      const msg = (raw ?? {}) as Record<string, unknown>;
      if (msg.role !== "user") continue;
      const text = sessionTextContent(msg.content);
      if (text) return text;
    }
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const raw of input) {
      const item = (raw ?? {}) as Record<string, unknown>;
      if (item.role !== "user") continue;
      const text = sessionTextContent(item.content);
      if (text) return text;
    }
  }
  return "";
}

export function sessionTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const raw of content) {
    const part = (raw ?? {}) as Record<string, unknown>;
    const text = stringValue(part.text).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n");
}
