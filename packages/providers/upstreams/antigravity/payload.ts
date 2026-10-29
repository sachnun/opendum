import { Payload, Value } from "@opendum/providers/helpers";
import { ToolNames, anySlice, mapSlice, type Json } from "@opendum/providers/upstreams/antigravity/common";
import { GeminiTier } from "@opendum/providers/upstreams/antigravity/model";
import { GeminiSchema } from "@opendum/providers/upstreams/antigravity/transform";
import { compareText } from "@opendum/models/compare";

const TOOL_ARTIFACT_MARKER = /^\s*(Tool:\s*\w+|(?:thought|think)\s*:)/i;

export class GeminiMedia {
  static mimeFromUrl(value: string): string {
    const lower = value.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".pdf")) return "application/pdf";
    return "application/octet-stream";
  }

  static fromDataUri(value: string): Json | null {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    const data = match[3] ?? "";
    if (isBase64) return { inlineData: { mimeType, data } };
    return { inlineData: { mimeType, data: Buffer.from(decodeURIComponent(data)).toString("base64") } };
  }
}

export class GeminiTierDetector {
  static projectId(data: Json): string {
    const value = Value.string(data.cloudaicompanionProject);
    if (value) return value;
    const project = data.cloudaicompanionProject;
    if (project !== null && typeof project === "object" && !Array.isArray(project)) {
      return Value.string((project as Json).id);
    }
    return "";
  }

  static tier(data: Json): string {
    const value = Value.string(data.currentTier);
    if (value) return GeminiTier.normalize(value);
    const tier = data.currentTier;
    if (tier !== null && typeof tier === "object" && !Array.isArray(tier)) {
      const id = Value.string((tier as Json).id);
      if (id) return GeminiTier.normalize(id);
      return GeminiTier.normalize(Value.string((tier as Json).name));
    }
    return "";
  }

  static paidTier(data: Json): string {
    const paidTier = data.paidTier;
    if (paidTier === null || typeof paidTier !== "object" || Array.isArray(paidTier)) return "";
    const id = GeminiTier.normalize(Value.string((paidTier as Json).id));
    return id && id !== "free-tier" ? id : "";
  }

  static allowed(data: Json): Json[] {
    return mapSlice(data.allowedTiers);
  }

  static detect(data: Json): string {
    let detected = "";
    for (const tier of GeminiTierDetector.allowed(data)) {
      if (tier.isDefault === true) {
        detected = GeminiTier.normalize(Value.string(tier.id));
        break;
      }
    }
    const paidTier = data.paidTier;
    if (paidTier !== null && typeof paidTier === "object" && !Array.isArray(paidTier)) {
      const id = GeminiTier.normalize(Value.string((paidTier as Json).id));
      if (id && GeminiTier.paid(id)) return id;
    }
    return detected;
  }

  static selectOnboard(fallback: string, allowedTiers: Json[]): string {
    for (const tier of allowedTiers) {
      if (tier.isDefault === true) {
        const id = Value.string(tier.id);
        if (id) return id;
      }
    }
    for (const tier of allowedTiers) {
      if (Value.string(tier.id) === "legacy-tier") return "legacy-tier";
    }
    if (allowedTiers.length > 0) return Value.string(allowedTiers[0].id);
    return fallback || "free-tier";
  }
}

export class GeminiPayload {
  static thinkingMap(value: unknown): Json | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Json;
    const out: Json = {};
    const budget = Value.number(record.thinkingBudget ?? record.thinking_budget);
    if (budget > 0) out.thinkingBudget = budget;
    const level = Value.stringOr(record.thinkingLevel, Value.string(record.thinking_level));
    if (level) out.thinkingLevel = level.toLowerCase();
    const include = record.includeThoughts ?? record.include_thoughts;
    if (typeof include === "boolean") out.include_thoughts = include;
    return Object.keys(out).length === 0 ? null : out;
  }

  static normalizeCached(payload: Json): void {
    const extra = payload.extra_body;
    if (extra !== null && typeof extra === "object" && !Array.isArray(extra)) {
      const value = Value.stringOr((extra as Json).cached_content, Value.string((extra as Json).cachedContent));
      if (value) payload.cachedContent = value;
      delete (extra as Json).cached_content;
      delete (extra as Json).cachedContent;
      if (Object.keys(extra as Json).length === 0) delete payload.extra_body;
    }
    const value = Value.stringOr(payload.cached_content, Value.string(payload.cachedContent));
    if (value) payload.cachedContent = value;
    delete payload.cached_content;
    delete payload.cachedContent;
  }

  static stripTrailingTurns(payload: Json): void {
    let contents = anySlice(payload.contents);
    while (contents.length > 1) {
      const last = (contents[contents.length - 1] ?? {}) as Json;
      if (last.role !== "model") break;
      contents = contents.slice(0, -1);
    }
    payload.contents = contents;
  }

  static sortDeclarations(payload: Json): void {
    for (const rawTool of anySlice(payload.tools)) {
      const tool = rawTool as Json;
      const decls = anySlice(tool.functionDeclarations);
      if (decls.length <= 1) continue;
      decls.sort((a, b) => compareText(Value.string((a as Json).name), Value.string((b as Json).name)));
      tool.functionDeclarations = decls;
    }
  }

  static ensureToolConfig(payload: Json): void {
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

  static normalizeClaudeTools(payload: Json): void {
    for (const rawTool of anySlice(payload.tools)) {
      const tool = rawTool as Json;
      for (const rawDecl of anySlice(tool.functionDeclarations)) {
        const decl = rawDecl as Json;
        if (decl.parametersJsonSchema !== undefined) {
          decl.parameters = decl.parametersJsonSchema;
          delete decl.parametersJsonSchema;
        }
        const rawParams = decl.parameters as Json | undefined;
        const params: Json =
          rawParams && typeof rawParams === "object"
            ? GeminiSchema.sanitizeClaude(rawParams)
            : { type: "object", properties: {} };
        if (params.type === undefined) params.type = "object";
        if (params.properties === undefined) params.properties = {};
        if (params.required === undefined) params.required = [];
        decl.parameters = params;
      }
    }
  }

  static sanitizeToolNames(payload: Json): void {
    for (const rawTool of anySlice(payload.tools)) {
      const tool = rawTool as Json;
      for (const rawDecl of anySlice(tool.functionDeclarations)) {
        const decl = rawDecl as Json;
        decl.name = ToolNames.sanitize(Value.string(decl.name));
      }
    }
  }
}

export class GeminiArtifacts {
  static scrubContent(content: Json): void {
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      const text = Value.string(part.text);
      if (!text) continue;
      part.text = GeminiArtifacts.scrubText(text);
    }
  }

  static scrubText(text: string): string {
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
}

export class GeminiToolBlocks {
  static sanitize(contents: unknown[]): unknown[] {
    const callIds = new Set<string>();
    const responseIds = new Set<string>();
    for (const rawContent of contents) {
      const content = rawContent as Json;
      for (const rawPart of anySlice(content.parts)) {
        const part = rawPart as Json;
        if (part.functionCall !== undefined) {
          const id = Value.string((part.functionCall as Json).id);
          if (id) callIds.add(id);
        }
        if (part.functionResponse !== undefined) {
          const id = Value.string((part.functionResponse as Json).id);
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
        if (part.functionCall !== undefined && !responseIds.has(Value.string((part.functionCall as Json).id))) {
          continue;
        }
        if (part.functionResponse !== undefined && !callIds.has(Value.string((part.functionResponse as Json).id))) {
          continue;
        }
        parts.push(rawPart);
      }
      if (parts.length > 0) {
        const copyContent = Payload.clone(content);
        copyContent.parts = parts;
        out.push(copyContent);
      }
    }
    return out;
  }

  static hasResponse(parts: unknown[]): boolean {
    return parts.some((rawPart) => (rawPart as Json).functionResponse !== undefined);
  }

  static groupResponses(contents: unknown[]): unknown[] {
    const out: Json[] = [];
    for (const rawContent of contents) {
      const content = rawContent as Json;
      const parts = anySlice(content.parts);
      if (content.role === "user" && GeminiToolBlocks.hasResponse(parts) && out.length > 0) {
        const last = out[out.length - 1];
        const lastParts = anySlice(last.parts);
        if (last.role === "user" && GeminiToolBlocks.hasResponse(lastParts)) {
          last.parts = [...lastParts, ...parts];
          continue;
        }
      }
      const copyContent = Payload.clone(content);
      copyContent.parts = [...parts];
      out.push(copyContent);
    }
    return out;
  }

  static append(target: unknown[], content: Json, parts: unknown[]): void {
    if (parts.length === 0) return;
    const copyContent = Payload.clone(content);
    copyContent.parts = parts;
    target.push(copyContent);
  }

  static separate(contents: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const rawContent of contents) {
      const content = rawContent as Json;
      const parts = anySlice(content.parts);
      if (parts.length === 0) {
        out.push(rawContent);
        continue;
      }
      const [textParts, thoughtParts, callParts, responseParts, otherParts] =
        GeminiToolBlocks.split(parts);
      if (content.role === "model") {
        if (callParts.length > 0 && textParts.length + thoughtParts.length > 0) {
          GeminiToolBlocks.append(out, content, [...thoughtParts, ...textParts, ...otherParts]);
          GeminiToolBlocks.append(out, content, callParts);
        } else {
          out.push(rawContent);
        }
      } else if (content.role === "user") {
        if (responseParts.length > 0) {
          GeminiToolBlocks.append(out, content, [...responseParts, ...otherParts]);
        } else {
          out.push(rawContent);
        }
      } else {
        out.push(rawContent);
      }
    }
    return out;
  }

  static split(parts: unknown[]): [unknown[], unknown[], unknown[], unknown[], unknown[]] {
    const textParts: unknown[] = [];
    const thoughtParts: unknown[] = [];
    const callParts: unknown[] = [];
    const responseParts: unknown[] = [];
    const otherParts: unknown[] = [];
    for (const rawPart of parts) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined) callParts.push(rawPart);
      else if (part.functionResponse !== undefined) responseParts.push(rawPart);
      else if (part.thought === true) thoughtParts.push(rawPart);
      else if (part.text !== undefined) textParts.push(rawPart);
      else otherParts.push(rawPart);
    }
    return [textParts, thoughtParts, callParts, responseParts, otherParts];
  }
}
