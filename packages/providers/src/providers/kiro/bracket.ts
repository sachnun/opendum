import { randomId } from "#providers/lib/helpers.ts";

export type KiroBracketToolCall = { id: string; name: string; arguments: string; raw: string };

export function findBalancedJsonEnd(text: string, start: number): number {
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

export function parseKiroBracketToolCalls(text: string): KiroBracketToolCall[] {
  const calls: KiroBracketToolCall[] = [];
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
    while (argsStart < text.length && (text[argsStart] === " " || text[argsStart] === "\n" || text[argsStart] === "\t")) {
      argsStart += 1;
    }
    if (!name || argsStart >= text.length || text[argsStart] !== "{") {
      search = argsStart;
      continue;
    }
    const argsEnd = findBalancedJsonEnd(text, argsStart);
    if (argsEnd === -1) break;
    let closeIdx = argsEnd + 1;
    while (closeIdx < text.length && (text[closeIdx] === " " || text[closeIdx] === "\n" || text[closeIdx] === "\t")) {
      closeIdx += 1;
    }
    if (closeIdx >= text.length || text[closeIdx] !== "]") {
      search = argsEnd + 1;
      continue;
    }
    const args = text.slice(argsStart, argsEnd + 1);
    try {
      JSON.parse(args);
    } catch {
      search = closeIdx + 1;
      continue;
    }
    calls.push({ id: randomId("toolu"), name, arguments: args, raw: text.slice(start, closeIdx + 1) });
    search = closeIdx + 1;
  }
  return calls;
}

export function cleanKiroBracketToolCalls(text: string, calls: KiroBracketToolCall[]): string {
  let cleaned = text;
  for (const call of calls) {
    cleaned = cleaned.split(call.raw).join("");
  }
  return cleaned.split(/\s+/).filter((part) => part !== "").join(" ").trim();
}
