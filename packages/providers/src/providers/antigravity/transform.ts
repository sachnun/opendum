import {
  cloneAnyMap,
  defaultEmpty,
  defaultStringValue,
  numberFromAny,
  randomId,
  stringValue,
} from "#providers/lib/helpers.ts";
import { sseDataLines } from "#providers/lib/sse.ts";
import {
  RETIRED_MODEL_PATTERN,
  anySlice,
  defaultAny,
  inferEnumType,
  type Json,
  mapSlice,
  normalizeSchemaType,
  randomHyphenId,
  sanitizedToolName,
} from "#providers/providers/antigravity/config.ts";
import type { AntigravityProvider } from "#providers/providers/antigravity/provider.ts";

export function geminiTools(raw: unknown): unknown[] {
  const out: unknown[] = [];
  for (const item of anySlice(raw)) {
    const tool = (item ?? {}) as Json;
    const fn = (tool.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    const paramsValue = fn.parameters;
    const params =
      paramsValue !== null && typeof paramsValue === "object" && !Array.isArray(paramsValue)
        ? (paramsValue as Json)
        : { type: "object", properties: {} };
    out.push({
      name,
      description: defaultStringValue(fn.description, ""),
      parameters: sanitizeGoogleFunctionSchema(params),
    });
  }
  return out;
}

export function sanitizeGoogleFunctionSchema(schema: Json | null | undefined): Json {
  if (!schema || typeof schema !== "object") return {};
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "type": {
        const typ = normalizeSchemaType(value);
        if (typ) out.type = typ;
        break;
      }
      case "properties": {
        const props =
          value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
        if (Object.keys(props).length === 0) continue;
        const cleaned: Json = {};
        for (const [name, rawProp] of Object.entries(props)) {
          if (rawProp !== null && typeof rawProp === "object" && !Array.isArray(rawProp)) {
            cleaned[name] = sanitizeGoogleFunctionSchema(rawProp as Json);
          }
        }
        if (Object.keys(cleaned).length > 0) out.properties = cleaned;
        break;
      }
      case "items":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          out.items = sanitizeGoogleFunctionSchema(value as Json);
        }
        break;
      case "anyOf": {
        const items: unknown[] = [];
        for (const rawItem of anySlice(value)) {
          if (rawItem !== null && typeof rawItem === "object" && !Array.isArray(rawItem)) {
            items.push(sanitizeGoogleFunctionSchema(rawItem as Json));
          }
        }
        if (items.length > 0) out.anyOf = items;
        break;
      }
      case "description":
      case "format":
      case "nullable":
      case "enum":
      case "required":
      case "propertyOrdering":
      case "minimum":
      case "maximum":
      case "minItems":
      case "maxItems":
      case "minLength":
      case "maxLength":
      case "pattern":
      case "title":
      case "default":
      case "example":
      case "minProperties":
      case "maxProperties":
        out[key] = value;
        break;
      default:
        break;
    }
  }
  if (schemaTypeAllowsNull(schema.type) && out.nullable === undefined) out.nullable = true;
  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = "object";
    else if (out.items !== undefined) out.type = "array";
  }
  return out;
}

export function schemaTypeAllowsNull(value: unknown): boolean {
  return anySlice(value).some((raw) => stringValue(raw) === "null");
}

export function sanitizeAntigravityClaudeToolSchema(schema: Json | null | undefined): Json {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  const flattened = flattenAntigravityClaudeUnion(schema);
  const out: Json = {};
  for (const [key, value] of Object.entries(flattened)) {
    switch (key) {
      case "type": {
        const typ = normalizeSchemaType(value);
        if (typ) out.type = typ;
        break;
      }
      case "properties": {
        const props =
          value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
        const cleaned: Json = {};
        for (const [name, rawProp] of Object.entries(props)) {
          if (rawProp !== null && typeof rawProp === "object" && !Array.isArray(rawProp)) {
            cleaned[name] = sanitizeAntigravityClaudeToolSchema(rawProp as Json);
          }
        }
        out.properties = cleaned;
        break;
      }
      case "items":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          out.items = sanitizeAntigravityClaudeToolSchema(value as Json);
        }
        break;
      case "description":
      case "enum":
        out[key] = value;
        break;
      default:
        break;
    }
  }
  if (flattened.const !== undefined && out.enum === undefined) out.enum = [flattened.const];
  if (out.type === undefined) out.type = inferAntigravityClaudeSchemaType(out);
  if (out.type === "object") {
    const props = (out.properties as Json | undefined) ?? {};
    out.properties = props;
    out.required = filteredSchemaRequired(flattened.required, props);
  }
  if (out.type === "array" && out.items === undefined) out.items = {};
  return out;
}

export function flattenAntigravityClaudeUnion(schema: Json): Json {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const options = mapSlice(schema[key]);
    if (options.length === 0) continue;
    const [mergedEnum, enumOk] = enumFromSchemaUnion(options);
    const base = cloneSchemaWithoutUnions(schema);
    if (enumOk) {
      base.enum = mergedEnum;
      if (base.type === undefined) base.type = inferEnumType(mergedEnum);
      return base;
    }
    const best = bestSchemaUnionOption(options);
    for (const [baseKey, baseValue] of Object.entries(base)) {
      if (best[baseKey] === undefined) best[baseKey] = baseValue;
    }
    return best;
  }
  return schema;
}

export function enumFromSchemaUnion(options: Json[]): [unknown[], boolean] {
  const values: unknown[] = [];
  for (const option of options) {
    if (normalizeSchemaType(option.type) === "null") continue;
    if (option.const !== undefined) {
      values.push(option.const);
      continue;
    }
    const enumValues = anySlice(option.enum);
    if (enumValues.length > 0) {
      values.push(...enumValues);
      continue;
    }
    return [[], false];
  }
  return [values, values.length > 0];
}

export function schemaUnionOptionScore(schema: Json): number {
  switch (normalizeSchemaType(schema.type)) {
    case "object": {
      const props = schema.properties;
      return props !== null && typeof props === "object" && !Array.isArray(props) && Object.keys(props as Json).length > 0
        ? 60
        : 50;
    }
    case "array":
      return schema.items !== undefined ? 45 : 40;
    case "string":
      return anySlice(schema.enum).length > 0 ? 35 : 30;
    case "number":
    case "integer":
      return 20;
    case "boolean":
      return 10;
    default:
      break;
  }
  if (schema.properties !== undefined) return 55;
  if (schema.items !== undefined) return 42;
  if (schema.const !== undefined || schema.enum !== undefined) return 32;
  return 1;
}

export function bestSchemaUnionOption(options: Json[]): Json {
  let best: Json = {};
  let bestScore = -1;
  for (const option of options) {
    if (normalizeSchemaType(option.type) === "null") continue;
    const score = schemaUnionOptionScore(option);
    if (score > bestScore) {
      bestScore = score;
      best = cloneAnyMap(option);
    }
  }
  if (bestScore === -1 && options.length > 0) best = cloneAnyMap(options[0]);
  return best;
}

export function cloneSchemaWithoutUnions(schema: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf" || key === "allOf") continue;
    out[key] = value;
  }
  return out;
}

export function filteredSchemaRequired(raw: unknown, props: Json): unknown[] {
  const required: unknown[] = [];
  const seen = new Set<string>();
  for (const value of anySlice(raw)) {
    const name = stringValue(value);
    if (!name || props[name] === undefined || seen.has(name)) continue;
    seen.add(name);
    required.push(name);
  }
  return required;
}

export function inferAntigravityClaudeSchemaType(schema: Json): string {
  if (schema.properties !== undefined) return "object";
  if (schema.items !== undefined) return "array";
  const enumValues = anySlice(schema.enum);
  if (enumValues.length > 0) return inferEnumType(enumValues);
  return "object";
}

export type ToolSchemaMap = Record<string, Record<string, { typ: string }>>;

export function buildToolSchemaMap(raw: unknown): ToolSchemaMap {
  const result: ToolSchemaMap = {};
  for (const tool of mapSlice(raw)) {
    for (const decl of mapSlice(tool.functionDeclarations)) {
      const originalName = stringValue(decl.name);
      if (!originalName) continue;
      const schemaValue = defaultAny(decl.parametersJsonSchema, decl.parameters);
      const schema =
        schemaValue !== null && typeof schemaValue === "object" && !Array.isArray(schemaValue)
          ? (schemaValue as Json)
          : {};
      const props =
        schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)
          ? (schema.properties as Json)
          : {};
      if (Object.keys(props).length === 0) continue;
      const paramMap: Record<string, { typ: string }> = {};
      for (const [paramName, rawParam] of Object.entries(props)) {
        const param = (rawParam ?? {}) as Json;
        paramMap[paramName] = { typ: defaultEmpty(normalizeSchemaType(param.type), "unknown") };
      }
      const sanitizedName = sanitizedToolName(originalName);
      result[sanitizedName] = paramMap;
      if (sanitizedName !== originalName) result[originalName] = paramMap;
    }
  }
  return result;
}

export function sanitizeToolSchemaKeys(schemas: ToolSchemaMap): void {
  for (const name of Object.keys(schemas)) {
    const sanitized = sanitizedToolName(name);
    if (sanitized !== name) schemas[sanitized] = schemas[name];
  }
}

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

export function geminiToOpenAiCompletion(response: Json, model: string, schemas: ToolSchemaMap): Json {
  let content = "";
  let reasoning = "";
  let toolCalls: unknown[] = [];
  const toolIndex = { value: 0 };
  for (const delta of geminiDeltas(response, schemas, toolIndex)) {
    content += stringValue(delta.content);
    reasoning += stringValue(delta.reasoning_content);
    if (Array.isArray(delta.tool_calls)) toolCalls = [...toolCalls, ...delta.tool_calls];
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  let finish = "stop";
  if (toolCalls.length > 0) {
    message.tool_calls = stripToolCallIndexes(toolCalls);
    finish = "tool_calls";
  } else {
    const mapped = geminiFinishReason(response, false);
    if (mapped) finish = mapped;
  }
  const usage = geminiUsage(response) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}

async function* transformGeminiSse(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): AsyncGenerator<string> {
  const completionId = randomId("chatcmpl");
  let sentRole = false;
  const toolIndex = { value: 0 };
  let hasToolCalls = false;
  let sentFinal = false;
  let trackedUsage: Json | null = null;
  const pending: string[] = [];

  const writeChunk = (delta: Json, finish: unknown, usage: Json | null): void => {
    const chunk: Json = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) chunk.usage = usage;
    pending.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const handleData = async (dataText: string): Promise<void> => {
    if (!dataText || dataText === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText) as unknown;
    } catch {
      return;
    }
    const response = unwrapGeminiResponse(parsed);
    await provider.cacheSignaturesFromResponse(response, model, sessionId);
    const notice = geminiRetiredModelResponse(response);
    if (notice) {
      writeChunk({ content: notice }, "stop", null);
      sentFinal = true;
      return;
    }
    const usage = geminiUsage(response);
    if (usage) trackedUsage = usage;
    for (const delta of geminiDeltas(response, schemas, toolIndex)) {
      if (!sentRole) {
        writeChunk({ role: "assistant", content: "" }, null, null);
        sentRole = true;
      }
      if (delta.tool_calls !== undefined) hasToolCalls = true;
      writeChunk(delta, null, null);
    }
    const finish = geminiFinishReason(response, hasToolCalls);
    if (finish) {
      writeChunk({}, finish, null);
      sentFinal = true;
    }
  };

  for await (const data of sseDataLines(source)) {
    await handleData(data);
    for (const chunk of pending.splice(0)) yield chunk;
  }

  if (trackedUsage) writeChunk({}, null, trackedUsage);
  if (!sentFinal) writeChunk({}, hasToolCalls ? "tool_calls" : "stop", null);
  pending.push("data: [DONE]\n\n");
  for (const chunk of pending.splice(0)) yield chunk;
}

export function geminiSseToOpenAiStream(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = transformGeminiSse(provider, source, model, sessionId, schemas)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

export async function geminiStreamToOpenAiCompletionImpl(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): Promise<Json> {
  let content = "";
  let reasoning = "";
  let toolCalls: unknown[] = [];
  let usage: Json | null = null;
  let finish = "stop";
  const toolIndex = { value: 0 };
  const handleData = async (dataText: string): Promise<boolean> => {
    if (!dataText || dataText === "[DONE]") return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText) as unknown;
    } catch {
      return false;
    }
    const response = unwrapGeminiResponse(parsed);
    await provider.cacheSignaturesFromResponse(response, model, sessionId);
    const notice = geminiRetiredModelResponse(response);
    if (notice) throw new Error(`antigravity model ${model} is retired: ${notice}`);
    for (const delta of geminiDeltas(response, schemas, toolIndex)) {
      content += stringValue(delta.content);
      reasoning += stringValue(delta.reasoning_content);
      if (Array.isArray(delta.tool_calls)) toolCalls = [...toolCalls, ...delta.tool_calls];
    }
    const nextUsage = geminiUsage(response);
    if (nextUsage) usage = nextUsage;
    const mapped = geminiFinishReason(response, toolCalls.length > 0);
    if (mapped) finish = mapped;
    return false;
  };
  for await (const data of sseDataLines(source)) {
    if (await handleData(data)) break;
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = stripToolCallIndexes(toolCalls);
    finish = "tool_calls";
  }
  const finalUsage = usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: randomId("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: finalUsage,
  };
}
