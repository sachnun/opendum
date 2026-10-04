import { KIRO_THINKING_END, KIRO_THINKING_TAGS } from "#providers/providers/kiro/constants.ts";

export class KiroThinkingSplitter {
  private buffer = "";
  private inThinking = false;
  private thinkingExtracted = false;
  private activeEndTag = "";

  constructor(enabled: boolean) {
    void enabled;
  }

  process(delta: string, final: boolean): [string, string] {
    this.buffer += delta;
    let content = "";
    let reasoning = "";
    while (this.buffer !== "") {
      if (!this.inThinking && !this.thinkingExtracted) {
        const { start, tag } = findKiroThinkingStartTag(this.buffer);
        if (start >= 0 && tag) {
          content += this.buffer.slice(0, start);
          this.buffer = this.buffer.slice(start + tag.start.length);
          this.inThinking = true;
          this.activeEndTag = tag.end;
          continue;
        }
        if (final) {
          content += this.buffer;
          this.buffer = "";
          break;
        }
        const safeLen = safeKiroUtf8PrefixLen(this.buffer, Math.max(0, this.buffer.length - maxKiroThinkingStartLen()));
        if (safeLen > 0) {
          content += this.buffer.slice(0, safeLen);
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }
      if (this.inThinking) {
        const endTag = this.activeEndTag || KIRO_THINKING_END;
        const end = findKiroRealTag(this.buffer, endTag);
        if (end >= 0) {
          reasoning += this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + endTag.length);
          this.inThinking = false;
          this.thinkingExtracted = true;
          if (this.buffer.startsWith("\n\n")) this.buffer = this.buffer.slice(2);
          continue;
        }
        if (final) {
          reasoning += this.buffer;
          this.buffer = "";
          break;
        }
        const safeLen = safeKiroUtf8PrefixLen(this.buffer, Math.max(0, this.buffer.length - endTag.length));
        if (safeLen > 0) {
          reasoning += this.buffer.slice(0, safeLen);
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }
      content += this.buffer;
      this.buffer = "";
    }
    return [content, reasoning];
  }

  flush(): [string, string] {
    return this.process("", true);
  }
}

export function safeKiroUtf8PrefixLen(value: string, maxLen: number): number {
  if (maxLen <= 0) return 0;
  if (maxLen >= value.length) return value.length;
  let len = maxLen;
  while (len > 0 && (value.charCodeAt(len) & 0xc0) === 0x80) len -= 1;
  return len;
}

export function findKiroThinkingStartTag(buffer: string): { start: number; tag: { start: string; end: string } | null } {
  let best = -1;
  let bestTag: { start: string; end: string } | null = null;
  for (const tag of KIRO_THINKING_TAGS) {
    const idx = findKiroRealTag(buffer, tag.start);
    if (idx >= 0 && (best === -1 || idx < best)) {
      best = idx;
      bestTag = tag;
    }
  }
  return { start: best, tag: bestTag };
}

export function maxKiroThinkingStartLen(): number {
  let maxLen = 0;
  for (const tag of KIRO_THINKING_TAGS) {
    if (tag.start.length > maxLen) maxLen = tag.start.length;
  }
  return maxLen;
}

export function findKiroRealTag(buffer: string, tag: string): number {
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
