import type { Registry } from "@opendum/models/runtime";
import { Value } from "../../core/helpers.js";
import { pick } from "./common.js";
import { KiroModel } from "./model.js";
import { KiroNames } from "./parser.js";
import { KiroHistory, KiroMessages, KiroToolCalls, KiroTools } from "./history.js";
import type { Json } from "./events.js";

const DEFAULT_BUDGETS: Record<string, number> = {
  low: 1024,
  medium: 10000,
  high: 32000,
  xhigh: 32000,
};

export class KiroThinking {
  static budgetFor(effort: string): number {
    return DEFAULT_BUDGETS[effort] ?? 0;
  }

  static explicit(body: Json): number {
    const direct = Value.number(body.thinking_budget);
    if (direct > 0) return direct;
    const reasoning = body.reasoning;
    if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      for (const key of ["max_tokens", "budget_tokens", "thinking_budget"]) {
        const budget = Value.number((reasoning as Json)[key]);
        if (budget > 0) return budget;
      }
    }
    return 0;
  }

  static effort(body: Json): string {
    const reasoning = body.reasoning;
    if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const effort = Value.string((reasoning as Json).effort);
      if (effort) return effort;
    }
    return Value.string(body.reasoning_effort);
  }

  static excluded(body: Json): boolean {
    if (body.include_thoughts === false) return true;
    const reasoning = body.reasoning;
    if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
      const value = pick((reasoning as Json).include_thoughts, (reasoning as Json).includeThoughts);
      if (value === false) return true;
    }
    return false;
  }

  static requested(registry: Registry, body: Json): boolean {
    if (KiroThinking.excluded(body) || KiroThinking.effort(body) === "none") return false;
    if (KiroThinking.explicit(body) > 0) return true;
    const effort = KiroThinking.effort(body);
    if (effort) return KiroThinking.budgetFor(effort) > 0;
    if (body.include_thoughts === true) return true;
    if (body._includeReasoning === true) return true;
    if (KiroNames.lastSegment(Value.string(body.model)).endsWith("-thinking")) return true;
    const model = Value.string(body.model);
    if (registry.isReasoningModel(model) || registry.isReasoningModel(KiroNames.lastSegment(model))) {
      return true;
    }
    for (const key of ["thinking_budget", "include_thoughts", "reasoning", "reasoning_effort"]) {
      if (body[key] !== undefined && body[key] !== null) return true;
    }
    return false;
  }

  static budget(body: Json): number {
    const explicit = KiroThinking.explicit(body);
    if (explicit > 0) return explicit;
    const fromEffort = KiroThinking.budgetFor(KiroThinking.effort(body));
    if (fromEffort > 0) return fromEffort;
    return 20000;
  }
}

export class KiroRequest {
  static build(registry: Registry, body: Json): Json {
    const modelId = KiroModel.normalize(registry, Value.string(body.model));
    const conversationId = KiroNames.conversationSeed(body);
    const tools = KiroTools.convert(body.tools);
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const { systemPrompt: baseSystem, messages: withoutSystem } = KiroMessages.splitSystem(rawMessages);
    let systemPrompt = baseSystem;
    const instructions = Value.string(body.instructions).trim();
    if (instructions) systemPrompt = [instructions, systemPrompt].filter((v) => v.trim() !== "").join("\n\n");
    if (KiroThinking.requested(registry, body)) {
      const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${KiroThinking.budget(
        body
      )}</max_thinking_length>`;
      if (!systemPrompt.includes("<thinking_mode>")) {
        systemPrompt = [prefix, systemPrompt].filter((v) => v.trim() !== "").join("\n");
      }
    }
    const messages = KiroMessages.normalizeToolMessages(KiroMessages.mergeAdjacent(withoutSystem));

    const history: unknown[] = [];
    if (messages.length > 1) {
      for (const raw of messages.slice(0, messages.length - 1)) {
        const item = KiroHistory.fromMessage(raw, modelId);
        if (item) history.push(item);
      }
    }

    let currentContent = "Continue";
    const currentContext: Json = {};
    if (messages.length > 0) {
      const last = (messages[messages.length - 1] ?? {}) as Json;
      const role = Value.string(last.role);
      if (role === "assistant") {
        const item = KiroHistory.fromMessage(last, modelId);
        if (item) history.push(item);
        currentContent = "[system: conversation continues]";
      } else {
        const { text, toolResults } = KiroToolCalls.userContent(last.content);
        currentContent = text;
        if (!currentContent) currentContent = toolResults.length > 0 ? "Tool results provided." : "Continue";
        if (toolResults.length > 0) currentContext.toolResults = toolResults;
      }
    }
    if (tools.length > 0) currentContext.tools = tools;

    const userInput: Json = { content: currentContent, modelId, origin: "AI_EDITOR" };
    if (Object.keys(currentContext).length > 0) userInput.userInputMessageContext = currentContext;
    if (KiroHistory.hasToolResults(userInput) && Value.string(userInput.content) === "Continue") {
      userInput.content = "Tool results provided.";
    }
    const reconciled = KiroHistory.reconcile(history, rawMessages, userInput, modelId);
    if (reconciled.length > 0) {
      const last = (reconciled[reconciled.length - 1] ?? {}) as Json;
      if (last.assistantResponseMessage === undefined) {
        reconciled.push({ assistantResponseMessage: { content: "[system: conversation continues]" } });
      }
    }
    if (systemPrompt) {
      if (!KiroHistory.injectSystem(reconciled, systemPrompt)) {
        if (!KiroHistory.hasToolResults(userInput)) {
          const existing = Value.string(userInput.content);
          userInput.content = [systemPrompt, existing].filter((v) => v.trim() !== "").join("\n\n");
        }
      }
    }
    const sanitizedHistory = KiroHistory.sanitizePairing(reconciled, userInput);

    const conversationState: Json = {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: { userInputMessage: userInput },
    };
    if (sanitizedHistory.length > 0) conversationState.history = sanitizedHistory;
    return { conversationState };
  }
}
