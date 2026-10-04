import { cloneAnyMap, defaultStringValue, numberFromAny, stringValue } from "#providers/lib/helpers.ts";
import { anySlice, type Json } from "#providers/providers/antigravity/config.ts";
import { defaultThinkingBudget } from "#providers/providers/antigravity/model-config.ts";
import { geminiTools } from "#providers/providers/antigravity/transform.ts";

export function inferMimeTypeFromUrl(value: string): string {
  let path: string;
  try {
    path = new URL(value).pathname;
  } catch {
    path = value;
  }
  const ext = path.toLowerCase().split(".").pop() ?? "";
  const table: Record<string, string> = {
    png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp",
    ico: "image/x-icon", tiff: "image/tiff", tif: "image/tiff", pdf: "application/pdf",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", avi: "video/x-msvideo",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  };
  return table[ext] ?? "image/jpeg";
}

function dataUriToGeminiPart(value: string): Json | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma === -1) return null;
  const meta = value.slice("data:".length, comma);
  const mimeType = meta.split(";")[0] || "image/png";
  return { inlineData: { mimeType, data: value.slice(comma + 1) } };
}

function reasoningEffort(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "";
  return stringValue((value as Json).effort);
}

function requestThinkingConfig(body: Json): Json {
  const config: Json = {};
  const budget = numberFromAny(body.thinking_budget);
  const effort = defaultStringValue(reasoningEffort(body.reasoning), stringValue(body.reasoning_effort));
  if (budget > 0) config.thinkingBudget = budget;
  else if (effort && effort !== "none") {
    const derived = defaultThinkingBudget(effort);
    if (derived > 0) config.thinkingBudget = derived;
  }
  if (Object.keys(config).length > 0 && body.include_thoughts !== undefined) {
    config.include_thoughts = body.include_thoughts;
  }
  return config;
}

export function openAiToGemini(body: Json): Json {
  const messages = anySlice(body.messages);
  let contents: unknown[] = [];
  const systemParts: unknown[] = [];
  const completed = completedToolCallIds(messages);
  const toolUseIds = toolUseIdSet(messages);
  const validToolResultIds = validToolResultIdSet(messages);
  const toolCallFunctionNames = toolCallFunctionNameMap(messages);
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    const role = stringValue(msg.role);
    if (role === "system" || role === "developer") {
      systemParts.push(...openAiContentTextParts(msg.content));
      continue;
    }
    let parts = openAiContentToGeminiParts(msg.content);
    parts = [...parts, ...openAiToolCallsToGeminiParts(msg, completed)];
    if (role === "tool") {
      const toolCallId = stringValue(msg.tool_call_id);
      if (!toolCallId || !validToolResultIds.has(toolCallId) || !toolUseIds.has(toolCallId)) continue;
      let functionName = stringValue(msg.name);
      if (!functionName) functionName = toolCallFunctionNames[toolCallId] ?? "";
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
  contents = separateTextAndToolParts(groupConsecutiveToolResponses(sanitizeGeminiContents(contents)));
  const payload: Json = { contents };
  if (systemParts.length > 0) payload.systemInstruction = { parts: systemParts };
  const generation: Json = {};
  if (body.temperature !== undefined && body.temperature !== null) generation.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) generation.topP = body.top_p;
  if (body.max_tokens !== undefined && body.max_tokens !== null) generation.maxOutputTokens = body.max_tokens;
  if (body.stop !== undefined && body.stop !== null) {
    if (Array.isArray(body.stop)) generation.stopSequences = body.stop;
    else if (stringValue(body.stop)) generation.stopSequences = [body.stop];
  }
  const thinking = requestThinkingConfig(body);
  if (Object.keys(thinking).length > 0) generation.thinkingConfig = thinking;
  if (Object.keys(generation).length > 0) payload.generationConfig = generation;
  const tools = geminiTools(body.tools);
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

function openAiContentTextParts(content: unknown): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  const parts: unknown[] = [];
  for (const raw of anySlice(content)) {
    const item = (raw ?? {}) as Json;
    if (item.type !== "text") continue;
    const text = stringValue(item.text);
    if (text) parts.push({ text });
  }
  return parts;
}

function completedToolCallIds(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) === "tool") {
      const id = stringValue(msg.tool_call_id);
      if (id) ids.add(id);
    }
    if (stringValue(msg.role) === "user") {
      for (const rawBlock of anySlice(msg.content)) {
        const block = (rawBlock ?? {}) as Json;
        if (block.type === "tool_result") {
          const id = stringValue(block.tool_use_id);
          if (id) ids.add(id);
        }
      }
    }
  }
  return ids;
}

function toolUseIdSet(messages: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "assistant") continue;
    for (const rawCall of anySlice(msg.tool_calls)) {
      const id = stringValue(((rawCall ?? {}) as Json).id);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function toolCallFunctionNameMap(messages: unknown[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    if (stringValue(msg.role) !== "assistant") continue;
    for (const rawCall of anySlice(msg.tool_calls)) {
      const call = (rawCall ?? {}) as Json;
      const id = stringValue(call.id);
      if (!id) continue;
      const fn = (call.function ?? {}) as Json;
      const name = stringValue(fn.name);
      if (name) names[id] = name;
    }
  }
  return names;
}

function validToolResultIdSet(messages: unknown[]): Set<string> {
  const valid = new Set<string>();
  let lastAssistantToolCallIds = new Set<string>();
  for (const raw of messages) {
    const msg = (raw ?? {}) as Json;
    switch (stringValue(msg.role)) {
      case "assistant": {
        lastAssistantToolCallIds = new Set<string>();
        for (const rawCall of anySlice(msg.tool_calls)) {
          const id = stringValue(((rawCall ?? {}) as Json).id);
          if (id) lastAssistantToolCallIds.add(id);
        }
        break;
      }
      case "tool": {
        const id = stringValue(msg.tool_call_id);
        if (id && lastAssistantToolCallIds.has(id)) valid.add(id);
        break;
      }
      case "user": {
        let hasToolResults = false;
        for (const rawBlock of anySlice(msg.content)) {
          const block = (rawBlock ?? {}) as Json;
          if (block.type !== "tool_result") continue;
          hasToolResults = true;
          const id = stringValue(block.tool_use_id);
          if (id && lastAssistantToolCallIds.has(id)) valid.add(id);
        }
        if (!hasToolResults) lastAssistantToolCallIds = new Set<string>();
        break;
      }
      case "system":
      case "developer":
        lastAssistantToolCallIds = new Set<string>();
        break;
      default:
        break;
    }
  }
  return valid;
}

function openAiToolCallsToGeminiParts(msg: Json, completed: Set<string>): unknown[] {
  const parts: unknown[] = [];
  for (const rawCall of anySlice(msg.tool_calls)) {
    const call = (rawCall ?? {}) as Json;
    const id = stringValue(call.id);
    if (id && !completed.has(id)) continue;
    const fn = (call.function ?? {}) as Json;
    const name = stringValue(fn.name);
    if (!name) continue;
    let args: unknown = {};
    const rawArgs = stringValue(fn.arguments);
    if (rawArgs) {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }
    }
    parts.push({ functionCall: { name, args, id } });
  }
  return parts;
}

function sanitizeGeminiContents(contents: unknown[]): unknown[] {
  const callIdx = new Map<string, number>();
  const responseIdx = new Map<string, number>();
  contents.forEach((rawContent, idx) => {
    const content = rawContent as Json;
    for (const rawPart of anySlice(content.parts)) {
      const part = rawPart as Json;
      if (part.functionCall !== undefined) {
        const id = stringValue((part.functionCall as Json).id);
        if (id) callIdx.set(id, idx);
      }
      if (part.functionResponse !== undefined) {
        const id = stringValue((part.functionResponse as Json).id);
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
      if (part.functionCall !== undefined && !validCalls.has(stringValue((part.functionCall as Json).id))) continue;
      if (part.functionResponse !== undefined && !validResponses.has(stringValue((part.functionResponse as Json).id))) continue;
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

function hasFunctionResponsePart(parts: unknown[]): boolean {
  return parts.some((rawPart) => (rawPart as Json).functionResponse !== undefined);
}

function groupConsecutiveToolResponses(contents: unknown[]): unknown[] {
  const out: Json[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts = anySlice(content.parts);
    if (content.role === "user" && hasFunctionResponsePart(parts) && out.length > 0) {
      const last = out[out.length - 1];
      const lastParts = anySlice(last.parts);
      if (last.role === "user" && hasFunctionResponsePart(lastParts)) {
        last.parts = [...lastParts, ...parts];
        continue;
      }
    }
    const copyContent = cloneAnyMap(content);
    copyContent.parts = [...parts];
    out.push(copyContent);
  }
  return out;
}

function appendContentParts(target: unknown[], content: Json, parts: unknown[]): void {
  if (parts.length === 0) return;
  const copyContent = cloneAnyMap(content);
  copyContent.parts = parts;
  target.push(copyContent);
}

function separateTextAndToolParts(contents: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const rawContent of contents) {
    const content = rawContent as Json;
    const parts = anySlice(content.parts);
    if (parts.length === 0) {
      out.push(rawContent);
      continue;
    }
    const [textParts, thoughtParts, callParts, responseParts, otherParts] = splitGeminiParts(parts);
    if (content.role === "model") {
      if (callParts.length > 0 && textParts.length + thoughtParts.length > 0) {
        appendContentParts(out, content, [...thoughtParts, ...textParts, ...otherParts]);
        appendContentParts(out, content, callParts);
      } else {
        out.push(rawContent);
      }
    } else if (content.role === "user") {
      if (responseParts.length > 0) appendContentParts(out, content, [...responseParts, ...otherParts]);
      else out.push(rawContent);
    } else {
      out.push(rawContent);
    }
  }
  return out;
}

function splitGeminiParts(parts: unknown[]): [unknown[], unknown[], unknown[], unknown[], unknown[]] {
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

function openAiContentToGeminiParts(content: unknown): unknown[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  const parts: unknown[] = [];
  for (const raw of anySlice(content)) {
    const item = (raw ?? {}) as Json;
    const text = stringValue(item.text);
    if (text) {
      parts.push({ text });
      continue;
    }
    if (item.type === "image_url") {
      const imageUrl = (item.image_url ?? {}) as Json;
      const url = stringValue(imageUrl.url);
      const part = dataUriToGeminiPart(url);
      if (part) parts.push(part);
      else if (url) parts.push({ fileData: { fileUri: url, mimeType: inferMimeTypeFromUrl(url) } });
    }
  }
  return parts;
}
