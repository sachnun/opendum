import { Value } from "@opendum/providers/helpers";
import { anySlice, type Json } from "@opendum/providers/upstreams/antigravity/common";
import { GeminiMedia, GeminiToolBlocks } from "@opendum/providers/upstreams/antigravity/payload";
import { GeminiModel } from "@opendum/providers/upstreams/antigravity/model";
import { GeminiSchema } from "@opendum/providers/upstreams/antigravity/transform";

export class GeminiToolCalls {
  static completedIds(messages: unknown[]): Set<string> {
    const ids = new Set<string>();
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      if (Value.string(msg.role) === "tool") {
        const id = Value.string(msg.tool_call_id);
        if (id) ids.add(id);
      }
      if (Value.string(msg.role) === "user") {
        for (const rawBlock of anySlice(msg.content)) {
          const block = (rawBlock ?? {}) as Json;
          if (block.type === "tool_result") {
            const id = Value.string(block.tool_use_id);
            if (id) ids.add(id);
          }
        }
      }
    }
    return ids;
  }

  static declaredIds(messages: unknown[]): Set<string> {
    const ids = new Set<string>();
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      if (Value.string(msg.role) !== "assistant") continue;
      for (const rawCall of anySlice(msg.tool_calls)) {
        const id = Value.string(((rawCall ?? {}) as Json).id);
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  static nameById(messages: unknown[]): Record<string, string> {
    const names: Record<string, string> = {};
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      if (Value.string(msg.role) !== "assistant") continue;
      for (const rawCall of anySlice(msg.tool_calls)) {
        const call = (rawCall ?? {}) as Json;
        const id = Value.string(call.id);
        if (!id) continue;
        const fn = (call.function ?? {}) as Json;
        const name = Value.string(fn.name);
        if (name) names[id] = name;
      }
    }
    return names;
  }

  static validResultIds(messages: unknown[]): Set<string> {
    const valid = new Set<string>();
    let assistantCallIds = new Set<string>();
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      switch (Value.string(msg.role)) {
        case "assistant": {
          assistantCallIds = new Set<string>();
          for (const rawCall of anySlice(msg.tool_calls)) {
            const id = Value.string(((rawCall ?? {}) as Json).id);
            if (id) assistantCallIds.add(id);
          }
          break;
        }
        case "tool": {
          const id = Value.string(msg.tool_call_id);
          if (id && assistantCallIds.has(id)) valid.add(id);
          break;
        }
        case "user": {
          let hasToolResults = false;
          for (const rawBlock of anySlice(msg.content)) {
            const block = (rawBlock ?? {}) as Json;
            if (block.type !== "tool_result") continue;
            hasToolResults = true;
            const id = Value.string(block.tool_use_id);
            if (id && assistantCallIds.has(id)) valid.add(id);
          }
          if (!hasToolResults) assistantCallIds = new Set<string>();
          break;
        }
        case "system":
        case "developer":
          assistantCallIds = new Set<string>();
          break;
        default:
          break;
      }
    }
    return valid;
  }

  static toParts(msg: Json, completed: Set<string>): unknown[] {
    const parts: unknown[] = [];
    for (const rawCall of anySlice(msg.tool_calls)) {
      const call = (rawCall ?? {}) as Json;
      const id = Value.string(call.id);
      if (id && !completed.has(id)) continue;
      const fn = (call.function ?? {}) as Json;
      const name = Value.string(fn.name);
      if (!name) continue;
      const rawArgs = Value.string(fn.arguments);
      const args: unknown = rawArgs ? (Value.parseJson(rawArgs) ?? {}) : {};
      parts.push({ functionCall: { name, args, id } });
    }
    return parts;
  }

  static sanitize(contents: unknown[]): unknown[] {
    const callIdx = new Map<string, number>();
    const responseIdx = new Map<string, number>();
    contents.forEach((rawContent, idx) => {
      const content = rawContent as Json;
      for (const rawPart of anySlice(content.parts)) {
        const part = rawPart as Json;
        if (part.functionCall !== undefined) {
          const id = Value.string((part.functionCall as Json).id);
          if (id) callIdx.set(id, idx);
        }
        if (part.functionResponse !== undefined) {
          const id = Value.string((part.functionResponse as Json).id);
          if (id) responseIdx.set(id, idx);
        }
      }
    });
    const validCalls = new Set<string>();
    const validResponses = new Set<string>();
    for (const [id, callAt] of callIdx) {
      const responseAt = responseIdx.get(id);
      if (responseAt !== undefined && responseAt > callAt) {
        validCalls.add(id);
        validResponses.add(id);
      }
    }
    const out: unknown[] = [];
    for (const rawContent of contents) {
      const content = rawContent as Json;
      const parts: unknown[] = [];
      for (const rawPart of anySlice(content.parts)) {
        const part = rawPart as Json;
        if (part.functionCall !== undefined && !validCalls.has(Value.string((part.functionCall as Json).id))) {
          continue;
        }
        if (part.functionResponse !== undefined && !validResponses.has(Value.string((part.functionResponse as Json).id))) {
          continue;
        }
        parts.push(rawPart);
      }
      if (parts.length > 0) {
        const copyContent = { ...content } as Json;
        copyContent.parts = parts;
        out.push(copyContent);
      }
    }
    return out;
  }
}

export class GeminiContent {
  static textParts(content: unknown): unknown[] {
    if (typeof content === "string") return [{ text: content }];
    const parts: unknown[] = [];
    for (const raw of anySlice(content)) {
      const item = (raw ?? {}) as Json;
      if (item.type !== "text") continue;
      const text = Value.string(item.text);
      if (text) parts.push({ text });
    }
    return parts;
  }

  static toParts(content: unknown): unknown[] {
    if (content === undefined || content === null) return [];
    if (typeof content === "string") return content ? [{ text: content }] : [];
    const parts: unknown[] = [];
    for (const raw of anySlice(content)) {
      const item = (raw ?? {}) as Json;
      const text = Value.string(item.text);
      if (text) {
        parts.push({ text });
        continue;
      }
      if (item.type === "image_url") {
        const imageUrl = (item.image_url ?? {}) as Json;
        const url = Value.string(imageUrl.url);
        const part = GeminiMedia.fromDataUri(url);
        if (part) parts.push(part);
        else if (url) {
          parts.push({ fileData: { fileUri: url, mimeType: GeminiMedia.mimeFromUrl(url) } });
        }
      }
    }
    return parts;
  }

  static thinkingConfig(body: Json): Json {
    const config: Json = {};
    const budget = Value.number(body.thinking_budget);
    const reasoning = body.reasoning;
    const effort = Value.stringOr(
      reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)
        ? Value.string((reasoning as Json).effort)
        : "",
      Value.string(body.reasoning_effort)
    );
    if (budget > 0) config.thinkingBudget = budget;
    else if (effort && effort !== "none") {
      const derived = GeminiModel.budgetFor(effort);
      if (derived > 0) config.thinkingBudget = derived;
    }
    if (Object.keys(config).length > 0 && body.include_thoughts !== undefined) {
      config.include_thoughts = body.include_thoughts;
    }
    return config;
  }
}

export class GeminiRequest {
  static build(body: Json): Json {
    const messages = anySlice(body.messages);
    let contents: unknown[] = [];
    const systemParts: unknown[] = [];
    const completed = GeminiToolCalls.completedIds(messages);
    const declared = GeminiToolCalls.declaredIds(messages);
    const validResults = GeminiToolCalls.validResultIds(messages);
    const namesById = GeminiToolCalls.nameById(messages);

    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      const role = Value.string(msg.role);
      if (role === "system" || role === "developer") {
        systemParts.push(...GeminiContent.textParts(msg.content));
        continue;
      }
      let parts = GeminiContent.toParts(msg.content);
      parts = [...parts, ...GeminiToolCalls.toParts(msg, completed)];
      if (role === "tool") {
        const toolCallId = Value.string(msg.tool_call_id);
        if (!toolCallId || !validResults.has(toolCallId) || !declared.has(toolCallId)) continue;
        let functionName = Value.string(msg.name);
        if (!functionName) functionName = namesById[toolCallId] ?? "";
        if (!functionName) functionName = "unknown";
        parts = [
          {
            functionResponse: {
              name: functionName,
              id: toolCallId,
              response: { result: msg.content },
            },
          },
        ];
      }
      const geminiRole = role === "assistant" ? "model" : "user";
      if (parts.length > 0) contents.push({ role: geminiRole, parts });
    }

    contents = GeminiToolBlocks.separate(GeminiToolBlocks.groupResponses(GeminiToolBlocks.sanitize(contents)));

    const payload: Json = { contents };
    if (systemParts.length > 0) payload.systemInstruction = { parts: systemParts };

    const generation: Json = {};
    if (body.temperature !== undefined && body.temperature !== null) generation.temperature = body.temperature;
    if (body.top_p !== undefined && body.top_p !== null) generation.topP = body.top_p;
    if (body.max_tokens !== undefined && body.max_tokens !== null) generation.maxOutputTokens = body.max_tokens;
    if (body.stop !== undefined && body.stop !== null) {
      if (Array.isArray(body.stop)) generation.stopSequences = body.stop;
      else if (Value.string(body.stop)) generation.stopSequences = [body.stop];
    }
    const thinking = GeminiContent.thinkingConfig(body);
    if (Object.keys(thinking).length > 0) generation.thinkingConfig = thinking;
    if (Object.keys(generation).length > 0) payload.generationConfig = generation;

    const tools = GeminiSchema.tools(body.tools);
    if (tools.length > 0) payload.tools = [{ functionDeclarations: tools }];
    for (const key of ["cached_content", "cachedContent", "extra_body", "system_instruction"]) {
      if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
    }
    payload.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    ];
    return payload;
  }
}
