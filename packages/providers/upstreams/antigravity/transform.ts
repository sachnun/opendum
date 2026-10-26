import { Value, Payload, Ids } from "../../core/helpers.js";
import {
  RETIRED_MODEL_PATTERN,
  ToolNames,
  anySlice,
  defaultAny,
  mapSlice,
  type Json,
} from "./common.js";
import type { AntigravityProvider } from "./index.js";

export type ToolSchemaMap = Record<string, Record<string, { typ: string }>>;

async function* sseGenerator(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): AsyncGenerator<string> {
  const completionId = Ids.random("chatcmpl");
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

  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const dataText = trimmed.slice("data:".length).trim();
    if (!dataText || dataText === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText) as unknown;
    } catch {
      return;
    }
    const response = GeminiResponse.unwrap(parsed);
    await provider.cacheSignatures(response, model, sessionId);
    const notice = GeminiResponse.retiredNotice(response);
    if (notice) {
      writeChunk({ content: notice }, "stop", null);
      sentFinal = true;
      return;
    }
    const usage = GeminiStream.usage(response);
    if (usage) trackedUsage = usage;
    for (const delta of GeminiStream.deltas(response, schemas, toolIndex)) {
      if (!sentRole) {
        writeChunk({ role: "assistant", content: "" }, null, null);
        sentRole = true;
      }
      if (delta.tool_calls !== undefined) hasToolCalls = true;
      writeChunk(delta, null, null);
    }
    const finish = GeminiStream.finishReason(response, hasToolCalls);
    if (finish) {
      writeChunk({}, finish, null);
      sentFinal = true;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        await handleLine(line);
        for (const chunk of pending.splice(0)) yield chunk;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      await handleLine(buffer);
      for (const chunk of pending.splice(0)) yield chunk;
    }
  } finally {
    reader.releaseLock();
  }

  if (trackedUsage) writeChunk({}, null, trackedUsage);
  if (!sentFinal) writeChunk({}, hasToolCalls ? "tool_calls" : "stop", null);
  pending.push("data: [DONE]\n\n");
  for (const chunk of pending.splice(0)) yield chunk;
}


export class GeminiSchema {
  static tools(raw: unknown): unknown[] {
  const out: unknown[] = [];
  for (const item of anySlice(raw)) {
    const tool = (item ?? {}) as Json;
    const fn = (tool.function ?? {}) as Json;
    const name = Value.string(fn.name);
    if (!name) continue;
    const paramsValue = fn.parameters;
    const params =
      paramsValue !== null && typeof paramsValue === "object" && !Array.isArray(paramsValue)
        ? (paramsValue as Json)
        : { type: "object", properties: {} };
    out.push({
      name,
      description: Value.stringOr(fn.description, ""),
      parameters: GeminiSchema.sanitizeFunction(params),
    });
  }
  return out;
}

  static sanitizeFunction(schema: Json | null | undefined): Json {
  if (!schema || typeof schema !== "object") return {};
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "type": {
        const typ = ToolNames.schemaType(value);
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
            cleaned[name] = GeminiSchema.sanitizeFunction(rawProp as Json);
          }
        }
        if (Object.keys(cleaned).length > 0) out.properties = cleaned;
        break;
      }
      case "items":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          out.items = GeminiSchema.sanitizeFunction(value as Json);
        }
        break;
      case "anyOf": {
        const items: unknown[] = [];
        for (const rawItem of anySlice(value)) {
          if (rawItem !== null && typeof rawItem === "object" && !Array.isArray(rawItem)) {
            items.push(GeminiSchema.sanitizeFunction(rawItem as Json));
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
  if (GeminiSchema.allowsNull(schema.type) && out.nullable === undefined) out.nullable = true;
  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];
  if (out.type === undefined) {
    if (out.properties !== undefined) out.type = "object";
    else if (out.items !== undefined) out.type = "array";
  }
  return out;
}

  static allowsNull(value: unknown): boolean {
  return anySlice(value).some((raw) => Value.string(raw) === "null");
}

  static sanitizeClaude(schema: Json | null | undefined): Json {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  const flattened = GeminiSchema.flattenUnion(schema);
  const out: Json = {};
  for (const [key, value] of Object.entries(flattened)) {
    switch (key) {
      case "type": {
        const typ = ToolNames.schemaType(value);
        if (typ) out.type = typ;
        break;
      }
      case "properties": {
        const props =
          value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
        const cleaned: Json = {};
        for (const [name, rawProp] of Object.entries(props)) {
          if (rawProp !== null && typeof rawProp === "object" && !Array.isArray(rawProp)) {
            cleaned[name] = GeminiSchema.sanitizeClaude(rawProp as Json);
          }
        }
        out.properties = cleaned;
        break;
      }
      case "items":
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          out.items = GeminiSchema.sanitizeClaude(value as Json);
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
  if (out.type === undefined) out.type = GeminiSchema.inferType(out);
  if (out.type === "object") {
    const props = (out.properties as Json | undefined) ?? {};
    out.properties = props;
    out.required = GeminiSchema.filteredRequired(flattened.required, props);
  }
  if (out.type === "array" && out.items === undefined) out.items = {};
  return out;
}

  static flattenUnion(schema: Json): Json {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const options = mapSlice(schema[key]);
    if (options.length === 0) continue;
    const [mergedEnum, enumOk] = GeminiSchema.enumFromUnion(options);
    const base = GeminiSchema.cloneWithoutUnions(schema);
    if (enumOk) {
      base.enum = mergedEnum;
      if (base.type === undefined) base.type = ToolNames.enumType(mergedEnum);
      return base;
    }
    const best = GeminiSchema.bestUnion(options);
    for (const [baseKey, baseValue] of Object.entries(base)) {
      if (best[baseKey] === undefined) best[baseKey] = baseValue;
    }
    return best;
  }
  return schema;
}

  static enumFromUnion(options: Json[]): [unknown[], boolean] {
  const values: unknown[] = [];
  for (const option of options) {
    if (ToolNames.schemaType(option.type) === "null") continue;
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

  static unionScore(schema: Json): number {
  switch (ToolNames.schemaType(schema.type)) {
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

  static bestUnion(options: Json[]): Json {
  let best: Json = {};
  let bestScore = -1;
  for (const option of options) {
    if (ToolNames.schemaType(option.type) === "null") continue;
    const score = GeminiSchema.unionScore(option);
    if (score > bestScore) {
      bestScore = score;
      best = Payload.clone(option);
    }
  }
  if (bestScore === -1 && options.length > 0) best = Payload.clone(options[0]);
  return best;
}

  static cloneWithoutUnions(schema: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf" || key === "allOf") continue;
    out[key] = value;
  }
  return out;
}

  static filteredRequired(raw: unknown, props: Json): unknown[] {
  const required: unknown[] = [];
  const seen = new Set<string>();
  for (const value of anySlice(raw)) {
    const name = Value.string(value);
    if (!name || props[name] === undefined || seen.has(name)) continue;
    seen.add(name);
    required.push(name);
  }
  return required;
}

  static inferType(schema: Json): string {
  if (schema.properties !== undefined) return "object";
  if (schema.items !== undefined) return "array";
  const enumValues = anySlice(schema.enum);
  if (enumValues.length > 0) return ToolNames.enumType(enumValues);
  return "object";
}

  static toolMap(raw: unknown): ToolSchemaMap {
  const result: ToolSchemaMap = {};
  for (const tool of mapSlice(raw)) {
    for (const decl of mapSlice(tool.functionDeclarations)) {
      const originalName = Value.string(decl.name);
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
        paramMap[paramName] = { typ: Value.nonEmpty(ToolNames.schemaType(param.type), "unknown") };
      }
      const sanitizedName = ToolNames.sanitize(originalName);
      result[sanitizedName] = paramMap;
      if (sanitizedName !== originalName) result[originalName] = paramMap;
    }
  }
  return result;
}

  static sanitizeKeys(schemas: ToolSchemaMap): void {
  for (const name of Object.keys(schemas)) {
    const sanitized = ToolNames.sanitize(name);
    if (sanitized !== name) schemas[sanitized] = schemas[name];
  }
}

}

export class GeminiArgs {
  static escapeSequences(value: unknown): unknown {
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

  static normalize(args: unknown, toolName: string, schemas: ToolSchemaMap): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const record = args as Json;
  const params = schemas[toolName] ?? {};
  const result: Json = {};
  for (const [key, value] of Object.entries(record)) {
    const expectedType = params[key]?.typ ?? "";
    if (expectedType === "string") {
      result[key] = GeminiArgs.escapeSequences(value);
      continue;
    }
    if (typeof value === "string" && (expectedType === "array" || expectedType === "object")) {
      try {
        result[key] = JSON.parse(value) as unknown;
      } catch {
        result[key] = GeminiArgs.escapeSequences(value);
      }
      continue;
    }
    result[key] = GeminiArgs.escapeSequences(value);
  }
  return result;
}

}

export class GeminiResponse {
  static unwrap(data: unknown): Json {
  if (Array.isArray(data)) {
    for (const item of data) {
      const unwrapped = GeminiResponse.unwrap(item);
      if (Object.keys(unwrapped).length > 0) return unwrapped;
    }
    return {};
  }
  const obj = (data ?? {}) as Json;
  const response = obj.response;
  if (response !== null && typeof response === "object" && !Array.isArray(response)) return response as Json;
  return obj;
}

  static retiredNotice(response: Json): string | null {
  const candidates = anySlice(response.candidates);
  if (candidates.length !== 1) return null;
  const candidate = (candidates[0] ?? {}) as Json;
  const content = (candidate.content ?? {}) as Json;
  const parts = anySlice(content.parts);
  if (parts.length !== 1) return null;
  const text = Value.string((parts[0] as Json).text).trim();
  if (!text || !RETIRED_MODEL_PATTERN.test(text)) return null;
  return text;
}

  static wrapCodeAssist(projectId: string, model: string, geminiPayload: Json): Json {
  return {
    project: projectId,
    model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: ToolNames.hyphenId("agent"),
    request: geminiPayload,
  };
}

  static retired(notice: string | null): Response {
  return new Response(JSON.stringify({ error: { code: 404, message: notice ?? "", status: "NOT_FOUND" } }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

  static async peekNotice(
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
        const notice = GeminiResponse.retiredNotice(GeminiResponse.unwrap(parsed));
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

}

export class GeminiStream {
  static deltas(response: Json, schemas: ToolSchemaMap, toolIndex: { value: number }): Json[] {
  const deltas: Json[] = [];
  for (const rawCandidate of anySlice(response.candidates)) {
    const candidate = (rawCandidate ?? {}) as Json;
    const content = (candidate.content ?? {}) as Json;
    const parts = anySlice(content.parts);
    let localToolIndex = 0;
    for (const rawPart of parts) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined && part.functionCall !== null) {
        const fn = part.functionCall as Json;
        const name = Value.string(fn.name);
        const args = GeminiArgs.normalize(fn.args, name, schemas);
        let encodedArgs = JSON.stringify(args);
        if (!encodedArgs || encodedArgs === "null") encodedArgs = "{}";
        let id = Value.string(fn.id);
        if (!id) id = Ids.random("call");
        const idx = toolIndex.value;
        toolIndex.value += 1;
        void localToolIndex;
        deltas.push({
          tool_calls: [{ index: idx, id, type: "function", function: { name, arguments: encodedArgs } }],
        });
        continue;
      }
      const text = Value.string(part.text);
      if (!text) continue;
      if (part.thought === true) deltas.push({ reasoning_content: text });
      else deltas.push({ content: text });
    }
  }
  return deltas;
}

  static stripIndexes(calls: unknown[]): unknown[] {
  return calls.map((rawCall) => {
    if (rawCall === null || typeof rawCall !== "object" || Array.isArray(rawCall)) return rawCall;
    const copyCall = Payload.clone(rawCall as Json);
    delete copyCall.index;
    return copyCall;
  });
}

  static usage(response: Json): Json | null {
  const rawUsage = response.usageMetadata;
  if (rawUsage === null || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return null;
  const usage = rawUsage as Json;
  const out: Json = {
    prompt_tokens: Value.number(usage.promptTokenCount),
    completion_tokens: Value.number(usage.candidatesTokenCount),
    total_tokens: Value.number(usage.totalTokenCount),
  };
  const cachedTokens = Value.number(usage.cachedContentTokenCount);
  if (cachedTokens > 0) out.prompt_tokens_details = { cached_tokens: cachedTokens };
  const thoughtsTokens = Value.number(usage.thoughtsTokenCount);
  if (thoughtsTokens > 0) out.completion_tokens_details = { reasoning_tokens: thoughtsTokens };
  return out;
}

  static finishReason(response: Json, hasToolCalls: boolean): string | null {
  for (const rawCandidate of anySlice(response.candidates)) {
    const candidate = (rawCandidate ?? {}) as Json;
    const finish = Value.string(candidate.finishReason);
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

  static sse(
  provider: AntigravityProvider,
  source: ReadableStream<Uint8Array>,
  model: string,
  sessionId: string,
  schemas: ToolSchemaMap
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = sseGenerator(provider, source, model, sessionId, schemas)[Symbol.asyncIterator]();
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

  static async completion(
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
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handleLine = async (line: string): Promise<boolean> => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const dataText = trimmed.slice("data:".length).trim();
    if (!dataText || dataText === "[DONE]") return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataText) as unknown;
    } catch {
      return false;
    }
    const response = GeminiResponse.unwrap(parsed);
    await provider.cacheSignatures(response, model, sessionId);
    const notice = GeminiResponse.retiredNotice(response);
    if (notice) throw new Error(`antigravity model ${model} is retired: ${notice}`);
    for (const delta of GeminiStream.deltas(response, schemas, toolIndex)) {
      content += Value.string(delta.content);
      reasoning += Value.string(delta.reasoning_content);
      if (Array.isArray(delta.tool_calls)) toolCalls = [...toolCalls, ...delta.tool_calls];
    }
    const nextUsage = GeminiStream.usage(response);
    if (nextUsage) usage = nextUsage;
    const mapped = GeminiStream.finishReason(response, toolCalls.length > 0);
    if (mapped) finish = mapped;
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (await handleLine(line)) break;
      }
    }
    buffer += decoder.decode();
    if (buffer) await handleLine(buffer);
  } finally {
    reader.releaseLock();
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) {
    message.tool_calls = GeminiStream.stripIndexes(toolCalls);
    finish = "tool_calls";
  }
  const finalUsage = usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: Ids.random("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: finalUsage,
  };
}
}

export class GeminiCompletion {
  static build(response: Json, model: string, schemas: ToolSchemaMap): Json {
  let content = "";
  let reasoning = "";
  let toolCalls: unknown[] = [];
  const toolIndex = { value: 0 };
  for (const delta of GeminiStream.deltas(response, schemas, toolIndex)) {
    content += Value.string(delta.content);
    reasoning += Value.string(delta.reasoning_content);
    if (Array.isArray(delta.tool_calls)) toolCalls = [...toolCalls, ...delta.tool_calls];
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  let finish = "stop";
  if (toolCalls.length > 0) {
    message.tool_calls = GeminiStream.stripIndexes(toolCalls);
    finish = "tool_calls";
  } else {
    const mapped = GeminiStream.finishReason(response, false);
    if (mapped) finish = mapped;
  }
  const usage = GeminiStream.usage(response) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    id: Ids.random("chatcmpl"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };
}
}
