import { Ids, Value } from "@opendum/providers/helpers";
import { ModelName } from "@opendum/providers/identity";
import { KiroBracket, KiroEvents, type Json } from "@opendum/providers/upstreams/kiro/events";

export const THINKING_START = "<thinking>";
export const THINKING_END = "</thinking>";

export const THINKING_TAGS = [
  { start: "<thinking>", end: "</thinking>" },
  { start: "<think>", end: "</think>" },
  { start: "<reasoning>", end: "</reasoning>" },
  { start: "<thought>", end: "</thought>" },
];

export type BracketToolCall = { id: string; name: string; arguments: string; raw: string };

class ThinkingTags {
  static findReal(buffer: string, tag: string): number {
    let pos = 0;
    let inCodeBlock = false;
    while (pos < buffer.length) {
      const tagRel = buffer.indexOf(tag, pos);
      if (tagRel === -1) return -1;
      const fenceRel = buffer.indexOf("```", pos);
      if (fenceRel !== -1 && pos + fenceRel < tagRel) {
        inCodeBlock = !inCodeBlock;
        pos += fenceRel + 3;
        continue;
      }
      if (!inCodeBlock) return tagRel;
      pos = tagRel + tag.length;
    }
    return -1;
  }

  static findStart(buffer: string): { start: number; tag: { start: string; end: string } | null } {
    let best = -1;
    let bestTag: { start: string; end: string } | null = null;
    for (const tag of THINKING_TAGS) {
      const idx = ThinkingTags.findReal(buffer, tag.start);
      if (idx >= 0 && (best === -1 || idx < best)) {
        best = idx;
        bestTag = tag;
      }
    }
    return { start: best, tag: bestTag };
  }

  static maxStartLength(): number {
    let maxLen = 0;
    for (const tag of THINKING_TAGS) {
      if (tag.start.length > maxLen) maxLen = tag.start.length;
    }
    return maxLen;
  }

  static safePrefixLength(value: string, maxLen: number): number {
    if (maxLen <= 0) return 0;
    if (maxLen >= value.length) return value.length;
    let len = maxLen;
    while (len > 0 && (value.charCodeAt(len) & 0xc0) === 0x80) len -= 1;
    return len;
  }
}

export class Parser {
  private eventBuffer = "";

  private contentBuffer = "";

  private inThinking = false;

  private thinkingExtracted = false;

  private activeEndTag = "";

  feed(source: string): Json[] {
    this.eventBuffer += source;
    const events: Json[] = [];
    let cursor = 0;
    while (cursor < this.eventBuffer.length) {
      const start = KiroEvents.nextStart(this.eventBuffer, cursor);
      if (start === -1) {
        this.eventBuffer = KiroEvents.tail(this.eventBuffer.slice(cursor));
        return events;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < this.eventBuffer.length; i += 1) {
        const ch = this.eventBuffer[i];
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
        this.eventBuffer = this.eventBuffer.slice(start);
        return events;
      }
      const candidate = this.eventBuffer.slice(start, end + 1);
      cursor = end + 1;
      const parsed = Value.parseJson(candidate) as Json;
      if (parsed === null) continue;
      for (const event of KiroEvents.expand(parsed)) {
        if (KiroEvents.relevant(event)) events.push(event);
      }
    }
    this.eventBuffer = "";
    return events;
  }

  finish(): Json[] {
    return this.feed("");
  }

  processContent(delta: string, final = false): [string, string] {
    this.contentBuffer += delta;
    let content = "";
    let reasoning = "";
    while (this.contentBuffer !== "") {
      if (!this.inThinking && !this.thinkingExtracted) {
        const { start, tag } = ThinkingTags.findStart(this.contentBuffer);
        if (start >= 0 && tag) {
          content += this.contentBuffer.slice(0, start);
          this.contentBuffer = this.contentBuffer.slice(start + tag.start.length);
          this.inThinking = true;
          this.activeEndTag = tag.end;
          continue;
        }
        if (final) {
          content += this.contentBuffer;
          this.contentBuffer = "";
          break;
        }
        const safeLen = ThinkingTags.safePrefixLength(
          this.contentBuffer,
          Math.max(0, this.contentBuffer.length - ThinkingTags.maxStartLength())
        );
        if (safeLen > 0) {
          content += this.contentBuffer.slice(0, safeLen);
          this.contentBuffer = this.contentBuffer.slice(safeLen);
        }
        break;
      }
      if (this.inThinking) {
        const endTag = this.activeEndTag || THINKING_END;
        const end = ThinkingTags.findReal(this.contentBuffer, endTag);
        if (end >= 0) {
          reasoning += this.contentBuffer.slice(0, end);
          this.contentBuffer = this.contentBuffer.slice(end + endTag.length);
          this.inThinking = false;
          this.thinkingExtracted = true;
          if (this.contentBuffer.startsWith("\n\n")) this.contentBuffer = this.contentBuffer.slice(2);
          continue;
        }
        if (final) {
          reasoning += this.contentBuffer;
          this.contentBuffer = "";
          break;
        }
        const safeLen = ThinkingTags.safePrefixLength(
          this.contentBuffer,
          Math.max(0, this.contentBuffer.length - endTag.length)
        );
        if (safeLen > 0) {
          reasoning += this.contentBuffer.slice(0, safeLen);
          this.contentBuffer = this.contentBuffer.slice(safeLen);
        }
        break;
      }
      content += this.contentBuffer;
      this.contentBuffer = "";
    }
    return [content, reasoning];
  }

  flushContent(): [string, string] {
    return this.processContent("", true);
  }
}

export class BracketCalls {
  static parse(text: string): BracketToolCall[] {
    const calls: BracketToolCall[] = [];
    let search = 0;
    while (search < text.length) {
      const startRel = text.indexOf("[Called ", search);
      if (startRel === -1) break;
      const start = startRel;
      const nameStart = start + "[Called ".length;
      const markerRel = text.indexOf(" with args:", nameStart);
      if (markerRel === -1) {
        search = nameStart;
        continue;
      }
      const name = text.slice(nameStart, markerRel).trim();
      let argsStart = markerRel + " with args:".length;
      while (
        argsStart < text.length &&
        (text[argsStart] === " " || text[argsStart] === "\n" || text[argsStart] === "\t")
      ) {
        argsStart += 1;
      }
      if (!name || argsStart >= text.length || text[argsStart] !== "{") {
        search = argsStart;
        continue;
      }
      const argsEnd = KiroBracket.balancedEnd(text, argsStart);
      if (argsEnd === -1) break;
      let closeIdx = argsEnd + 1;
      while (
        closeIdx < text.length &&
        (text[closeIdx] === " " || text[closeIdx] === "\n" || text[closeIdx] === "\t")
      ) {
        closeIdx += 1;
      }
      if (closeIdx >= text.length || text[closeIdx] !== "]") {
        search = argsEnd + 1;
        continue;
      }
      const args = text.slice(argsStart, argsEnd + 1);
      if (Value.parseJson(args) === null) {
        search = closeIdx + 1;
        continue;
      }
      calls.push({ id: Ids.random("toolu"), name, arguments: args, raw: text.slice(start, closeIdx + 1) });
      search = closeIdx + 1;
    }
    return calls;
  }

  static clean(text: string, calls: BracketToolCall[]): string {
    let cleaned = text;
    for (const call of calls) {
      cleaned = cleaned.split(call.raw).join("");
    }
    return cleaned
      .split(/\s+/)
      .filter((part) => part !== "")
      .join(" ")
      .trim();
  }
}

export class KiroNames {
  static lastSegment(model: string): string {
    return ModelName.segment(model);
  }

  static truncate(value: string, maxLen: number): string {
    if (maxLen <= 0 || value.length <= maxLen) return value;
    return value.slice(0, maxLen);
  }

  static float(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  static conversationSeed(body: Json): string {
    const session = Value.string(body._sessionId).trim();
    if (session) return KiroNames.conversationFromSeed(session);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    for (const raw of messages) {
      const message = (raw ?? {}) as Json;
      if (Value.string(message.role) !== "user") continue;
      const text = Value.string(message.content).trim();
      if (!text) continue;
      return KiroNames.conversationFromSeed(text);
    }
    return Ids.random("conversation");
  }

  private static conversationFromSeed(seed: string): string {
    return `conversation_${new Bun.CryptoHasher("sha256").update(seed).digest("hex").slice(0, 32)}`;
  }
}
