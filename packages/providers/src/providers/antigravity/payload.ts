import { cloneAnyMap, defaultStringValue, numberFromAny, stringValue } from "#providers/lib/helpers.ts";
import { anySlice, defaultAny, type Json, sanitizedToolName } from "#providers/providers/antigravity/config.ts";
import { TOOL_ARTIFACT_MARKER } from "#providers/providers/antigravity/runtime.ts";
import { sanitizeAntigravityClaudeToolSchema } from "#providers/providers/antigravity/transform.ts";

export function normalizedThinkingMap(value: unknown): Json | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Json;
  const out: Json = {};
  const budget = numberFromAny(defaultAny(record.thinkingBudget, record.thinking_budget));
  if (budget > 0) out.thinkingBudget = budget;
  const level = defaultStringValue(record.thinkingLevel, stringValue(record.thinking_level));
  if (level) out.thinkingLevel = level.toLowerCase();
  const include = defaultAny(record.includeThoughts, record.include_thoughts);
  if (typeof include === "boolean") out.include_thoughts = include;
  return Object.keys(out).length === 0 ? null : out;
}

export function normalizeCachedContent(payload: Json): void {
  const extra = payload.extra_body;
  if (extra !== null && typeof extra === "object" && !Array.isArray(extra)) {
    const value = defaultStringValue((extra as Json).cached_content, stringValue((extra as Json).cachedContent));
    if (value) payload.cachedContent = value;
    delete (extra as Json).cached_content;
    delete (extra as Json).cachedContent;
    if (Object.keys(extra as Json).length === 0) delete payload.extra_body;
  }
  const value = defaultStringValue(payload.cached_content, stringValue(payload.cachedContent));
  if (value) payload.cachedContent = value;
  delete payload.cached_content;
  delete payload.cachedContent;
}

export function stripTrailingModelTurns(payload: Json): void {
  let contents = anySlice(payload.contents);
  while (contents.length > 1) {
    const last = (contents[contents.length - 1] ?? {}) as Json;
    if (last.role !== "model") break;
    contents = contents.slice(0, -1);
  }
  payload.contents = contents;
}

export function sortFunctionDeclarations(payload: Json): void {
  for (const rawTool of anySlice(payload.tools)) {
    const tool = rawTool as Json;
    const decls = anySlice(tool.functionDeclarations);
    if (decls.length <= 1) continue;
    decls.sort((a, b) => stringValue((a as Json).name).localeCompare(stringValue((b as Json).name)));
    tool.functionDeclarations = decls;
  }
}

export function ensureToolConfig(payload: Json): void {
  let toolConfig = payload.toolConfig as Json | undefined;
  if (!toolConfig || typeof toolConfig !== "object") {
    toolConfig = {};
    payload.toolConfig = toolConfig;
  }
  let calling = toolConfig.functionCallingConfig as Json | undefined;
  if (!calling || typeof calling !== "object") {
    calling = {};
    toolConfig.functionCallingConfig = calling;
  }
  calling.mode = "VALIDATED";
}

export function normalizeClaudeTools(payload: Json): void {
  for (const rawTool of anySlice(payload.tools)) {
    const tool = rawTool as Json;
    for (const rawDecl of anySlice(tool.functionDeclarations)) {
      const decl = rawDecl as Json;
      if (decl.parametersJsonSchema !== undefined) {
        decl.parameters = decl.parametersJsonSchema;
        delete decl.parametersJsonSchema;
      }
      let params = decl.parameters as Json | undefined;
      if (!params || typeof params !== "object") params = { type: "object", properties: {} };
      params = sanitizeAntigravityClaudeToolSchema(params);
      if (params.type === undefined) params.type = "object";
      if (params.properties === undefined) params.properties = {};
      if (params.required === undefined) params.required = [];
      decl.parameters = params;
    }
  }
}

export function sanitizeGeminiToolNames(payload: Json): void {
  for (const rawTool of anySlice(payload.tools)) {
    const tool = rawTool as Json;
    for (const rawDecl of anySlice(tool.functionDeclarations)) {
      const decl = rawDecl as Json;
      decl.name = sanitizedToolName(stringValue(decl.name));
    }
  }
}

export function scrubConversationArtifacts(content: Json): void {
  for (const rawPart of anySlice(content.parts)) {
    const part = rawPart as Json;
    const text = stringValue(part.text);
    if (!text) continue;
    part.text = scrubToolTranscriptArtifacts(text);
  }
}

export function scrubToolTranscriptArtifacts(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let inFence = false;
  let fenceStart = "";
  let fenceLines: string[] = [];
  const flushFence = (end: string): void => {
    const cleaned: string[] = [];
    let hadMarker = false;
    for (const line of fenceLines) {
      if (TOOL_ARTIFACT_MARKER.test(line)) {
        hadMarker = true;
        continue;
      }
      cleaned.push(line);
    }
    const hasContent = cleaned.some((line) => line.trim() !== "");
    if (!hadMarker || hasContent) {
      output.push(fenceStart, ...cleaned, end);
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceStart = line;
        fenceLines = [];
        continue;
      }
      flushFence(line);
      inFence = false;
      continue;
    }
    if (inFence) {
      fenceLines.push(line);
      continue;
    }
    if (TOOL_ARTIFACT_MARKER.test(line)) continue;
    output.push(line);
  }
  if (inFence) output.push(fenceStart, ...fenceLines);
  let cleaned = output.join("\n");
  while (cleaned.includes("\n\n\n\n")) cleaned = cleaned.replace(/\n\n\n\n/g, "\n\n\n");
  return cleaned;
}

export function sanitizeToolBlocks(contents: unknown[]): unknown[] {
  const callIds = new Set<string>();
  const responseIds = new Set<string>();
  for (const rawContent of contents) {
    const content = rawContent as Json;
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined) {
        const id = stringValue((part.functionCall as Json).id);
        if (id) callIds.add(id);
      }
      if (part.functionResponse !== undefined) {
        const id = stringValue((part.functionResponse as Json).id);
        if (id) responseIds.add(id);
      }
    }
  }
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts: unknown[] = [];
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined && !responseIds.has(stringValue((part.functionCall as Json).id))) continue;
      if (part.functionResponse !== undefined && !callIds.has(stringValue((part.functionResponse as Json).id))) continue;
      parts.push(rawPart);
    }
    if (parts.length > 0) {
      const copyContent = cloneAnyMap(content);
      copyContent.parts = parts;
      out.push(copyContent);
    }
  }
  return out;
}
