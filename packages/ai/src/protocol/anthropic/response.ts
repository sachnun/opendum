export function convertOpenAIToAnthropicJSON(
  openAI: any,
  model: string
): Record<string, unknown> {
  const choice = openAI.choices?.[0];
  const message = choice?.message || {};
  const content: any[] = [];
  let stopReason = "end_turn";

  if (message.reasoning_content || message.reasoning) {
    content.push({
      type: "thinking",
      thinking: message.reasoning_content || message.reasoning,
    });
  }

  if (message.content) {
    content.push({
      type: "text",
      text: message.content,
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name,
        input,
      });
    }
    stopReason = "tool_use";
  }

  if (choice?.finish_reason === "length") {
    stopReason = "max_tokens";
  }

  const inputTokens =
    openAI.usage?.prompt_tokens ?? openAI.usage?.input_tokens ?? 0;
  const outputTokens =
    openAI.usage?.completion_tokens ?? openAI.usage?.output_tokens ?? 0;

  return {
    id: openAI.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}
