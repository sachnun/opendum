import { Content } from "./parsing";
import type { PlaygroundEndpoint, PlaygroundSettings, ReasoningEffort, ScenarioMessage } from "./types";

const BUDGETS: Record<string, number> = {
  low: 4000,
  medium: 8000,
  high: 16000,
  xhigh: 32000,
  max: 64000,
};

export class Body {
  static budget(effort: ReasoningEffort): number {
    return BUDGETS[effort] ?? 0;
  }

  static adaptive(modelId: string): boolean {
    const normalized = modelId.toLowerCase();
    return normalized === "claude-opus-4-7" || normalized === "claude-opus-4.7";
  }

  static anthropicContent(
    content: ScenarioMessage["content"]
  ): string | Array<Record<string, unknown>> {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      if ((part as { type?: unknown }).type === "text") {
        return typeof (part as { text?: unknown }).text === "string"
          ? [{ type: "text", text: (part as { text: string }).text }]
          : [];
      }
      if ((part as { type?: unknown }).type === "image_url") {
        const imageUrl = (part as { image_url?: unknown }).image_url;
        const url =
          typeof imageUrl === "string"
            ? imageUrl
            : imageUrl && typeof imageUrl === "object"
              ? (imageUrl as { url?: unknown }).url
              : null;
        return typeof url === "string" && url.trim()
          ? [{ type: "image", source: { type: "url", url: url.trim() } }]
          : [];
      }
      return [part];
    });
  }

  static anthropicMessages(messages: ScenarioMessage[]) {
    const systemParts: string[] = [];
    const converted: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];

    for (const message of messages) {
      if (message.role === "system") {
        const systemText = Content.message(message.content);
        if (systemText) systemParts.push(systemText);
        continue;
      }
      converted.push({
        role: message.role === "assistant" ? "assistant" : "user",
        content: Body.anthropicContent(message.content),
      });
    }

    if (converted.length === 0) converted.push({ role: "user", content: "" });
    return { system: systemParts.length > 0 ? systemParts.join("\n\n") : null, messages: converted };
  }

  static responsesInput(messages: ScenarioMessage[]) {
    return messages.map((message) => ({
      type: "message",
      role:
        message.role === "system" ? "developer" : message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  }

  static build(
    modelId: string,
    messages: ScenarioMessage[],
    settings: PlaygroundSettings
  ): Record<string, unknown> {
    if (settings.endpoint === "messages") {
      const anthropic = Body.anthropicMessages(messages);
      const requestBody: Record<string, unknown> = {
        model: modelId,
        messages: anthropic.messages,
        stream: settings.streamResponses,
        temperature: settings.temperature,
        top_p: settings.topP,
        max_tokens: settings.maxTokens,
        presence_penalty: settings.presencePenalty,
        frequency_penalty: settings.frequencyPenalty,
      };
      if (anthropic.system) requestBody.system = anthropic.system;
      if (settings.reasoningEffort !== "none") {
        if (Body.adaptive(modelId)) {
          requestBody.thinking = { type: "adaptive" };
          requestBody.output_config = { effort: settings.reasoningEffort };
        } else {
          requestBody.thinking = {
            type: "enabled",
            budget_tokens: Body.budget(settings.reasoningEffort),
          };
        }
      }
      return requestBody;
    }

    const requestBody: Record<string, unknown> =
      settings.endpoint === "responses"
        ? {
            model: modelId,
            input: Body.responsesInput(messages),
            stream: settings.streamResponses,
            temperature: settings.temperature,
            top_p: settings.topP,
            max_output_tokens: settings.maxTokens,
            presence_penalty: settings.presencePenalty,
            frequency_penalty: settings.frequencyPenalty,
          }
        : {
            model: modelId,
            messages,
            stream: settings.streamResponses,
            temperature: settings.temperature,
            top_p: settings.topP,
            max_tokens: settings.maxTokens,
            presence_penalty: settings.presencePenalty,
            frequency_penalty: settings.frequencyPenalty,
          };

    if (settings.reasoningEffort !== "none") {
      requestBody.reasoning_effort = settings.reasoningEffort;
    }
    return requestBody;
  }

  static route(
    requestBody: Record<string, unknown>,
    provider: string | null,
    accountId: string | null
  ): void {
    const selector = accountId ?? provider;
    if (!selector) return;
    const model = typeof requestBody.model === "string" ? requestBody.model.trim() : "";
    if (model && !model.startsWith(`${selector}/`)) requestBody.model = `${selector}/${model}`;
  }

  static overrides(
    overrides: Record<string, unknown> | undefined,
    endpoint: PlaygroundEndpoint
  ): Record<string, unknown> | null {
    if (!overrides) return null;
    if (endpoint !== "messages") return overrides;

    const adapted = { ...overrides };
    if (Array.isArray(adapted.tools)) {
      adapted.tools = adapted.tools.flatMap((tool) => {
        if (!tool || typeof tool !== "object" || (tool as { type?: unknown }).type !== "function") {
          return [];
        }
        const fn = (tool as { function?: unknown }).function;
        if (!fn || typeof fn !== "object" || typeof (fn as { name?: unknown }).name !== "string") {
          return [];
        }
        return [
          {
            name: (fn as { name: string }).name,
            description: (fn as { description?: unknown }).description,
            input_schema: (fn as { parameters?: unknown }).parameters ?? {},
          },
        ];
      });
    }
    if (adapted.tool_choice === "auto") adapted.tool_choice = { type: "auto" };
    if (adapted.tool_choice === "none") adapted.tool_choice = { type: "none" };
    if (adapted.tool_choice === "required") adapted.tool_choice = { type: "any" };
    return adapted;
  }
}
