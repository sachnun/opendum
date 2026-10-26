import { Ids, Payload, Value } from "@opendum/providers/core/helpers";
import { pick } from "@opendum/providers/upstreams/kiro/common";
import { KiroNames } from "@opendum/providers/upstreams/kiro/parser";
import type { Json } from "@opendum/providers/upstreams/kiro/events";

export const THINKING_START = "<thinking>";
export const THINKING_END = "</thinking>";

export class KiroTools {
  static convert(raw: unknown): unknown[] {
    if (!Array.isArray(raw)) return [];
    const result: unknown[] = [];
    for (const item of raw) {
      const tool = (item ?? {}) as Json;
      let fn = (tool.function ?? {}) as Json;
      let name = Value.string(fn.name).trim();
      if (!name) {
        name = Value.string(tool.name).trim();
        fn = tool;
      }
      if (!name) continue;
      const paramsValue = pick(fn.parameters, fn.input_schema);
      const params =
        paramsValue !== null && typeof paramsValue === "object" && !Array.isArray(paramsValue)
          ? (paramsValue as Json)
          : { type: "object", properties: {} };
      result.push({
        toolSpecification: {
          name,
          description: KiroNames.truncate(Value.stringOr(fn.description, ""), 9216),
          inputSchema: { json: params },
        },
      });
    }
    return result;
  }
}

export class KiroMessages {
  static splitSystem(rawMessages: unknown[]): { systemPrompt: string; messages: unknown[] } {
    const systemParts: string[] = [];
    const messages: unknown[] = [];
    for (const raw of rawMessages) {
      const msg = (raw ?? {}) as Json;
      const role = Value.string(msg.role);
      if (role === "system" || role === "developer") {
        const text = Payload.text(msg.content).trim();
        if (text) systemParts.push(text);
        continue;
      }
      messages.push(raw);
    }
    return { systemPrompt: systemParts.join("\n\n"), messages };
  }

  static mergeContent(a: unknown, b: unknown): unknown {
    const aParts = Array.isArray(a) ? a : null;
    const bParts = Array.isArray(b) ? b : null;
    if (aParts && bParts) return [...aParts, ...bParts];
    if (aParts) {
      const text = Value.string(b);
      return text ? [...aParts, { type: "text", text }] : a;
    }
    if (bParts) {
      const text = Value.string(a);
      return text ? [{ type: "text", text }, ...bParts] : b;
    }
    const left = Payload.text(a);
    const right = Payload.text(b);
    return [left, right].filter((value) => value.trim() !== "").join("\n");
  }

  static normalizeToolMessages(messages: unknown[]): unknown[] {
    const normalized: unknown[] = [];
    let pendingToolResults: unknown[] = [];
    const flushPending = (): void => {
      if (pendingToolResults.length === 0) return;
      normalized.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    };
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      const role = Value.string(msg.role);
      if (role === "tool") {
        pendingToolResults.push({
          type: "tool_result",
          tool_call_id: Value.stringOr(msg.tool_call_id, Ids.random("toolu")),
          content: msg.content,
        });
        continue;
      }
      if (role === "assistant") {
        flushPending();
        normalized.push(raw);
        continue;
      }
      if (role === "user" && pendingToolResults.length > 0) {
        const copyMsg = Payload.clone(msg);
        copyMsg.content = KiroMessages.mergeContent(pendingToolResults, msg.content);
        normalized.push(copyMsg);
        pendingToolResults = [];
        continue;
      }
      normalized.push(raw);
    }
    flushPending();
    return normalized;
  }

  static mergeAdjacent(messages: unknown[]): unknown[] {
    const merged: Json[] = [];
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      const role = Value.string(msg.role);
      if (merged.length > 0 && role !== "tool") {
        const last = merged[merged.length - 1];
        if (Value.string(last.role) === role) {
          last.content = KiroMessages.mergeContent(last.content, msg.content);
          if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const existing = Array.isArray(last.tool_calls) ? (last.tool_calls as unknown[]) : [];
            last.tool_calls = [...existing, ...(msg.tool_calls as unknown[])];
          }
          continue;
        }
      }
      merged.push(Payload.clone(msg));
    }
    return merged;
  }
}

export class KiroToolCalls {
  static fromCall(rawCall: unknown): Json | null {
    const call = (rawCall ?? {}) as Json;
    const fn = (call.function ?? {}) as Json;
    const id = Value.string(call.id);
    const name = Value.string(fn.name);
    if (!id || !name) return null;
    let input: unknown = {};
    const args = Value.string(fn.arguments);
    if (args) {
      try {
        input = JSON.parse(args);
      } catch {
        input = {};
      }
    }
    return { toolUseId: id, name, input };
  }

  static assistantContent(message: Json): { content: string; toolUses: unknown[] } {
    let content = "";
    let thinking = "";
    const toolUses: unknown[] = [];
    if (Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        const part = (rawPart ?? {}) as Json;
        switch (Value.string(part.type)) {
          case "text":
          case "output_text":
            content += Payload.text(part);
            break;
          case "thinking":
            thinking += Value.stringOr(part.thinking, Value.string(part.text));
            break;
          case "tool_use": {
            const id = Value.string(part.id);
            const name = Value.string(part.name);
            if (id && name) toolUses.push({ toolUseId: id, name, input: pick(part.input, {}) });
            break;
          }
          default:
            break;
        }
      }
    } else {
      content = Payload.text(message.content);
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const rawCall of message.tool_calls) {
        const toolUse = KiroToolCalls.fromCall(rawCall);
        if (toolUse) toolUses.push(toolUse);
      }
    }
    if (thinking) {
      const wrapped = `${THINKING_START}${thinking}${THINKING_END}`;
      content = content ? `${wrapped}\n\n${content}` : wrapped;
    }
    return { content, toolUses };
  }

  static resultsFromContent(content: unknown): unknown[] {
    if (!Array.isArray(content)) return [];
    const results: unknown[] = [];
    for (const raw of content) {
      const part = (raw ?? {}) as Json;
      if (Value.string(part.type) !== "tool_result") continue;
      const id = Value.stringOr(part.tool_use_id, Value.string(part.tool_call_id));
      if (!id) continue;
      results.push(KiroToolCalls.result(id, Payload.text(part.content)));
    }
    return results;
  }

  static userContent(content: unknown): { text: string; toolResults: unknown[] } {
    if (
      typeof content === "string" ||
      (content !== null && typeof content === "object" && !Array.isArray(content))
    ) {
      return { text: Payload.text(content), toolResults: [] };
    }
    if (!Array.isArray(content) || content.length === 0) return { text: "", toolResults: [] };
    const textParts: unknown[] = [];
    const toolResults: unknown[] = [];
    for (const raw of content) {
      const part = (raw ?? {}) as Json;
      if (Value.string(part.type) === "tool_result") {
        const id = Value.stringOr(part.tool_use_id, Value.string(part.tool_call_id));
        if (id) toolResults.push(KiroToolCalls.result(id, Payload.text(part.content)));
        continue;
      }
      textParts.push(raw);
    }
    return { text: Payload.text(textParts), toolResults: KiroToolCalls.dedupe(toolResults) };
  }

  static result(id: string, text: string): Json {
    return { toolUseId: id, status: "success", content: [{ text }] };
  }

  static dedupe(results: unknown[]): unknown[] {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const raw of results) {
      const result = (raw ?? {}) as Json;
      const id = Value.string(result.toolUseId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(raw);
    }
    return out;
  }

  static resultText(result: Json): string {
    return Payload.text(result.content);
  }
}

export class KiroHistory {
  static fromMessage(raw: unknown, modelId: string): Json | null {
    const message = (raw ?? {}) as Json;
    const role = Value.string(message.role);
    if (role === "assistant") {
      const { content, toolUses } = KiroToolCalls.assistantContent(message);
      if (!content && toolUses.length === 0) return null;
      const assistant: Json = { content };
      if (toolUses.length > 0) assistant.toolUses = toolUses;
      return { assistantResponseMessage: assistant };
    }
    if (role === "tool") {
      const text = Payload.text(message.content);
      let toolResults = KiroToolCalls.resultsFromContent(message.content);
      if (toolResults.length === 0) {
        toolResults = [
          KiroToolCalls.result(Value.stringOr(message.tool_call_id, Ids.random("toolu")), text),
        ];
      }
      return {
        userInputMessage: {
          content: "Tool results provided.",
          modelId,
          origin: "AI_EDITOR",
          userInputMessageContext: { toolResults: KiroToolCalls.dedupe(toolResults) },
        },
      };
    }
    if (role === "user") {
      const { text, toolResults } = KiroToolCalls.userContent(message.content);
      let content = text;
      if (!content) content = toolResults.length > 0 ? "Tool results provided." : "Continue";
      const userInput: Json = { content, modelId, origin: "AI_EDITOR" };
      if (toolResults.length > 0) userInput.userInputMessageContext = { toolResults };
      return { userInputMessage: userInput };
    }
    return null;
  }

  static hasToolResults(userInput: Json): boolean {
    const ctx = (userInput.userInputMessageContext ?? {}) as Json;
    const results = ctx.toolResults;
    return Array.isArray(results) && results.length > 0;
  }

  static historyIds(history: unknown[]): Record<string, boolean> {
    const ids: Record<string, boolean> = {};
    for (const raw of history) {
      const item = (raw ?? {}) as Json;
      const assistant = (item.assistantResponseMessage ?? {}) as Json;
      const toolUses = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
      for (const rawUse of toolUses) {
        const id = Value.string(((rawUse ?? {}) as Json).toolUseId);
        if (id) ids[id] = true;
      }
    }
    return ids;
  }

  static findOriginalCall(messages: unknown[], toolUseId: string): Json | null {
    for (const raw of messages) {
      const msg = (raw ?? {}) as Json;
      if (Value.string(msg.role) !== "assistant") continue;
      if (Array.isArray(msg.tool_calls)) {
        for (const rawCall of msg.tool_calls) {
          const toolUse = KiroToolCalls.fromCall(rawCall);
          if (toolUse && toolUse.toolUseId === toolUseId) return toolUse;
        }
      }
      if (Array.isArray(msg.content)) {
        for (const rawPart of msg.content) {
          const part = (rawPart ?? {}) as Json;
          if (Value.string(part.type) === "tool_use" && Value.string(part.id) === toolUseId) {
            return { toolUseId, name: Value.string(part.name), input: pick(part.input, {}) };
          }
        }
      }
    }
    return null;
  }

  static setToolResults(userInput: Json, results: unknown[]): void {
    const ctx = (userInput.userInputMessageContext ?? {}) as Json;
    if (results.length > 0) ctx.toolResults = KiroToolCalls.dedupe(results);
    else delete ctx.toolResults;
    if (Object.keys(ctx).length > 0) userInput.userInputMessageContext = ctx;
    else delete userInput.userInputMessageContext;
  }

  static reconcile(
    history: unknown[],
    rawMessages: unknown[],
    userInput: Json,
    modelId: string
  ): unknown[] {
    const ctx = (userInput.userInputMessageContext ?? {}) as Json;
    const rawResults = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    if (rawResults.length === 0) return history;
    const historyIds = KiroHistory.historyIds(history);
    const finalResults: unknown[] = [];
    const orphanedToolUses: unknown[] = [];
    for (const raw of rawResults) {
      const result = (raw ?? {}) as Json;
      const id = Value.string(result.toolUseId);
      if (!id || historyIds[id]) {
        finalResults.push(raw);
        continue;
      }
      const original = KiroHistory.findOriginalCall(rawMessages, id);
      if (original) {
        orphanedToolUses.push(original);
        finalResults.push(raw);
        historyIds[id] = true;
        continue;
      }
      const existing = Value.string(userInput.content);
      const output = `[Output for tool call ${id}]:\n${KiroToolCalls.resultText(result)}`;
      userInput.content = [existing, output].filter((value) => value.trim() !== "").join("\n\n");
    }
    if (orphanedToolUses.length > 0) {
      const last = history[history.length - 1];
      if (history.length === 0 || (last as Json).assistantResponseMessage !== undefined) {
        history.push({ userInputMessage: { content: "Running tools...", modelId, origin: "AI_EDITOR" } });
      }
      history.push({
        assistantResponseMessage: { content: "I will execute the following tools.", toolUses: orphanedToolUses },
      });
    }
    KiroHistory.setToolResults(userInput, finalResults);
    return history;
  }

  static injectSystem(history: unknown[], systemPrompt: string): boolean {
    for (const raw of history) {
      const item = (raw ?? {}) as Json;
      const user = item.userInputMessage;
      if (user === null || typeof user !== "object" || Array.isArray(user)) continue;
      const userInput = user as Json;
      if (KiroHistory.hasToolResults(userInput)) continue;
      const existing = Value.string(userInput.content);
      userInput.content = [systemPrompt, existing].filter((value) => value.trim() !== "").join("\n\n");
      return true;
    }
    return false;
  }

  static toolUseIds(assistant: Json): Record<string, boolean> | null {
    const uses = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
    if (uses.length === 0) return null;
    const ids: Record<string, boolean> = {};
    for (const rawUse of uses) {
      const id = Value.string(((rawUse ?? {}) as Json).toolUseId);
      if (id) ids[id] = true;
    }
    return ids;
  }

  static sanitizeResults(
    user: Json,
    allowed: Record<string, boolean> | null
  ): Record<string, boolean> | null {
    const ctx = (user.userInputMessageContext ?? {}) as Json;
    const results = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    if (results.length === 0 || !allowed) return null;
    const kept: unknown[] = [];
    const keptIds: Record<string, boolean> = {};
    for (const raw of results) {
      const result = (raw ?? {}) as Json;
      const id = Value.string(result.toolUseId);
      if (id && allowed[id]) {
        kept.push(raw);
        keptIds[id] = true;
        continue;
      }
      const existing = Value.string(user.content);
      const output = `[Output for tool call ${Value.nonEmpty(id, "unknown")}]:\n${KiroToolCalls.resultText(result)}`;
      user.content = [existing, output].filter((value) => value.trim() !== "").join("\n\n");
    }
    KiroHistory.setToolResults(user, kept);
    return Object.keys(keptIds).length === 0 ? null : keptIds;
  }

  static filterToolUses(
    assistant: Json | null,
    resultIds: Record<string, boolean> | null
  ): void {
    if (!assistant) return;
    const uses = Array.isArray(assistant.toolUses) ? assistant.toolUses : [];
    if (uses.length === 0) return;
    const kept = uses.filter(
      (rawUse) => resultIds?.[Value.string(((rawUse ?? {}) as Json).toolUseId)] === true
    );
    if (kept.length > 0) assistant.toolUses = kept;
    else delete assistant.toolUses;
  }

  static sanitizePairing(history: unknown[], currentUser: Json): unknown[] {
    const sanitized: unknown[] = [];
    let pendingAssistant: Json | null = null;
    let pendingToolIds: Record<string, boolean> | null = null;
    for (const raw of history) {
      const item = (raw ?? {}) as Json;
      const assistant = item.assistantResponseMessage;
      if (assistant !== null && typeof assistant === "object" && !Array.isArray(assistant)) {
        const assistantObj = assistant as Json;
        KiroHistory.filterToolUses(pendingAssistant, null);
        pendingAssistant = assistantObj;
        pendingToolIds = KiroHistory.toolUseIds(assistantObj);
        sanitized.push(raw);
        continue;
      }
      const user = item.userInputMessage;
      if (user !== null && typeof user === "object" && !Array.isArray(user)) {
        const resultIds = KiroHistory.sanitizeResults(user as Json, pendingToolIds);
        KiroHistory.filterToolUses(pendingAssistant, resultIds);
        pendingAssistant = null;
        pendingToolIds = null;
      }
      sanitized.push(raw);
    }
    const currentResultIds = KiroHistory.sanitizeResults(currentUser, pendingToolIds);
    KiroHistory.filterToolUses(pendingAssistant, currentResultIds);
    return sanitized;
  }
}
