import { Value } from "../../core/helpers.js";
import { Collector } from "../../transform/collector.js";
import { KiroUsage } from "./events.js";
import { BracketCalls, Parser } from "./parser.js";
import type { Json } from "./events.js";

export class KiroCompletion {
  static fromEvents(events: Json[], model: string): Json {
    let content = "";
    let reasoning = "";
    let outputText = "";
    let activeToolId = "";
    let contextUsagePercentage = 0;
    let explicitUsage: Json | null = null;
    const parser = new Parser();
    let hasNativeReasoning = false;
    const toolById = new Map<string, { name: string; args: string }>();

    for (const event of events) {
      if (event.contextUsagePercentage !== undefined) {
        contextUsagePercentage = KiroUsage.float(event.contextUsagePercentage);
      }
      const usage = KiroUsage.fromEvent(event);
      if (usage) explicitUsage = usage;
      if (KiroUsage.errorMessage(event)) continue;
      const reasoningDelta = KiroUsage.reasoningText(event);
      if (reasoningDelta) {
        hasNativeReasoning = true;
        reasoning += reasoningDelta;
        outputText += reasoningDelta;
      }
      if (typeof event.content === "string" && event.followupPrompt === undefined) {
        const [textDelta, reasoningPart] = parser.processContent(event.content, false);
        content += textDelta;
        if (!hasNativeReasoning) reasoning += reasoningPart;
        outputText += textDelta + reasoningPart;
      }
      const name = Value.string(event.name);
      const toolUseId = Value.string(event.toolUseId);
      if (name && toolUseId) {
        activeToolId = toolUseId;
        if (!toolById.has(toolUseId)) {
          toolById.set(toolUseId, { name, args: "" });
        }
        const input = Value.string(event.input);
        if (input) (toolById.get(toolUseId) as { name: string; args: string }).args += input;
      }
      const input = Value.string(event.input);
      if (input && !Value.string(event.name) && activeToolId) {
        const entry = toolById.get(activeToolId);
        if (entry) entry.args += input;
      }
      if (event.stop === true) activeToolId = "";
    }

    const [flushText, flushReasoning] = parser.flushContent();
    content += flushText;
    if (!hasNativeReasoning) reasoning += flushReasoning;
    outputText += flushText + flushReasoning;

    const collector = new Collector({
      model,
      nullContent: true,
      normalizeArgs: (args) => Value.nonEmpty(args, "{}"),
    });
    for (const [id, call] of toolById) {
      collector.addToolCall({ key: id, id, name: call.name, arguments: call.args });
    }
    const bracketCalls = BracketCalls.parse(content);
    if (bracketCalls.length > 0) {
      content = BracketCalls.clean(content, bracketCalls);
      for (const call of bracketCalls) {
        collector.addToolCall({
          key: call.id,
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }
    collector.addContent(content);
    collector.addReasoning(reasoning);
    collector.setUsage(
      explicitUsage ?? KiroUsage.fromContext(model, contextUsagePercentage, outputText)
    );
    return collector.toCompletion();
  }
}
