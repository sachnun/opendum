import {
  cloneAnyMap,
  numberFromAny,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import {
  RETIRED_MODEL_PATTERN,
  anySlice,
  type Json,
  randomHyphenId,
} from "#providers/providers/antigravity/config.ts";
import type { ToolSchemaMap } from "#providers/providers/antigravity/schema.ts";

export {
  bestSchemaUnionOption,
  buildToolSchemaMap,
  cloneSchemaWithoutUnions,
  enumFromSchemaUnion,
  filteredSchemaRequired,
  flattenAntigravityClaudeUnion,
  geminiTools,
  inferAntigravityClaudeSchemaType,
  sanitizeAntigravityClaudeToolSchema,
  sanitizeGoogleFunctionSchema,
  sanitizeToolSchemaKeys,
  schemaTypeAllowsNull,
  schemaUnionOptionScore,
} from "#providers/providers/antigravity/schema.ts";
export type { ToolSchemaMap } from "#providers/providers/antigravity/schema.ts";
export {
  geminiSseToOpenAiStream,
  geminiStreamToOpenAiCompletionImpl,
  geminiToOpenAiCompletion,
} from "#providers/providers/antigravity/completion.ts";

export function processEscapeSequencesOnly(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if ((!value.includes("\\n") && !value.includes("\\t")) || value.includes('\\"') || value.includes("\\\\")) {
    return value;
  }
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as unknown;
  } catch {
    return value;
  }
}

export function normalizeToolCallArgs(args: unknown, toolName: string, schemas: ToolSchemaMap): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const record = args as Json;
  const params = schemas[toolName] ?? {};
  const result: Json = {};
  for (const [key, value] of Object.entries(record)) {
    const expectedType = params[key]?.typ ?? "";
    if (expectedType === "string") {
      result[key] = processEscapeSequencesOnly(value);
      continue;
    }
    if (typeof value === "string" && (expectedType === "array" || expectedType === "object")) {
      try {
        result[key] = JSON.parse(value) as unknown;
      } catch {
        result[key] = processEscapeSequencesOnly(value);
      }
      continue;
    }
    result[key] = processEscapeSequencesOnly(value);
  }
  return result;
}

export function unwrapGeminiResponse(data: unknown): Json {
  if (Array.isArray(data)) {
    for (const item of data) {
      const unwrapped = unwrapGeminiResponse(item);
      if (Object.keys(unwrapped).length > 0) return unwrapped;
    }
    return {};
  }
  const obj = (data ?? {}) as Json;
  const response = obj.response;
  if (response !== null && typeof response === "object" && !Array.isArray(response)) return response as Json;
  return obj;
}

export function geminiRetiredModelResponse(response: Json): string | null {
  const candidates = anySlice(response.candidates);
  if (candidates.length !== 1) return null;
  const candidate = (candidates[0] ?? {}) as Json;
  const content = (candidate.content ?? {}) as Json;
  const parts = anySlice(content.parts);
  if (parts.length !== 1) return null;
  const text = stringValue((parts[0] as Json).text).trim();
  if (!text || !RETIRED_MODEL_PATTERN.test(text)) return null;
  return text;
}

export function wrapCodeAssistPayload(projectId: string, model: string, geminiPayload: Json): Json {
  return {
    project: projectId,
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: randomHyphenId("agent"),
    request: geminiPayload,
  };
}

export function retiredResponse(notice: string | null): Response {
  return new Response(JSON.stringify({ error: { code: 404, message: notice ?? "", status: "NOT_FOUND" } }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

export async function peekRetiredNotice(
  resp: Response
): Promise<{ retired: boolean; notice: string | null; body: ReadableStream<Uint8Array> | null }> {
  if (!resp.body) return { retired: false, notice: null, body: null };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const prefix: Uint8Array[] = [];
  let buffered = "";
  let sawData = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        prefix.push(value);
        buffered += decoder.decode(value, { stream: true });
      }
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        sawData = true;
        const dataText = trimmed.slice("data:".length).trim();
        if (!dataText || dataText === "[DONE]") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataText) as unknown;
        } catch {
          continue;
        }
        const notice = geminiRetiredModelResponse(unwrapGeminiResponse(parsed));
        if (notice) {
          await reader.cancel().catch(() => undefined);
          return { retired: true, notice, body: null };
        }
      }
      if (sawData) break;
    }
  } finally {
    reader.releaseLock();
  }
  const remaining = resp.body.getReader();
  let prefixIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefix.length) {
        controller.enqueue(prefix[prefixIndex]);
        prefixIndex += 1;
        return;
      }
      const { done, value } = await remaining.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel(reason) {
      await remaining.cancel(reason);
    },
  });
  return { retired: false, notice: null, body };
}

export function geminiDeltas(response: Json, schemas: ToolSchemaMap, toolIndex: { value: number }): Json[] {
  const deltas: Json[] = [];
  for (const rawCandidate of anySlice(response.candidates)) {
    const candidate = (rawCandidate ?? {}) as Json;
    const content = (candidate.content ?? {}) as Json;
    const parts = anySlice(content.parts);
    const localToolIndex = 0;
    for (const rawPart of parts) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined && part.functionCall !== null) {
        const fn = part.functionCall as Json;
        const name = stringValue(fn.name);
        const args = normalizeToolCallArgs(fn.args, name, schemas);
        let encodedArgs = JSON.stringify(args);
        if (!encodedArgs || encodedArgs === "null") encodedArgs = "{}";
        let id = stringValue(fn.id);
        if (!id) id = randomId("call");
        const idx = toolIndex.value;
        toolIndex.value += 1;
        void localToolIndex;
        deltas.push({
          tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: encodedArgs } }],
        });
        continue;
      }
      const text = stringValue(part.text);
      if (!text) continue;
      if (part.thought === true) deltas.push({ reasoning_content: text });
      else deltas.push({ content: text });
    }
  }
  return deltas;
}

export function stripToolCallIndexes(calls: unknown[]): unknown[] {
  return calls.map((rawCall) => {
    if (rawCall === null || typeof rawCall !== "object" || Array.isArray(rawCall)) return rawCall;
    const copyCall = cloneAnyMap(rawCall as Json);
    delete copyCall.index;
    return copyCall;
  });
}

export function geminiUsage(response: Json): Json | null {
  const rawUsage = response.usageMetadata;
  if (rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return null;
  const usage = rawUsage as Json;
  const out: Json = {
    prompt_tokens: numberFromAny(usage.promptTokenCount),
    completion_tokens: numberFromAny(usage.candidatesTokenCount),
    total_tokens: numberFromAny(usage.totalTokenCount),
  };
  const cachedTokens = numberFromAny(usage.cachedContentTokenCount);
  if (cachedTokens > 0) out.prompt_tokens_details = { cached_tokens: cachedTokens };
  const thoughtsTokens = numberFromAny(usage.thoughtsTokenCount);
  if (thoughtsTokens > 0) out.completion_tokens_details = { reasoning_tokens: thoughtsTokens };
  return out;
}

export function geminiFinishReason(response: Json, hasToolCalls: boolean): string | null {
  for (const rawCandidate of anySlice(response.candidates)) {
    const candidate = (rawCandidate ?? {}) as Json;
    const finish = stringValue(candidate.finishReason);
    if (!finish) continue;
    if (hasToolCalls) return "tool_calls";
    switch (finish) {
      case "MAX_TOKENS":
        return "length";
      case "TOOL_CALLS":
        return "tool_calls";
      default:
        return "stop";
    }
  }
  return null;
}

