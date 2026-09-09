export interface AnthropicStreamCallbacks {
  onEvent(event: string, data: Record<string, unknown>): void;
  onUsage(inputTokens: number, outputTokens: number): void;
}

export function createAnthropicStreamTransformer(
  model: string,
  callbacks: AnthropicStreamCallbacks
) {
  const messageId = `msg_${Date.now()}`;
  let blockIndex = 0;
  let currentBlockType: "text" | "thinking" | "tool_use" | null = null;
  let finishReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;

  callbacks.onEvent("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  function closeCurrentBlock() {
    if (currentBlockType !== null) {
      callbacks.onEvent("content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
      blockIndex++;
      currentBlockType = null;
    }
  }

  return {
    processChunk(chunkObj: any) {
      if (chunkObj.usage) {
        if (typeof chunkObj.usage.prompt_tokens === "number") {
          inputTokens = chunkObj.usage.prompt_tokens;
        } else if (typeof chunkObj.usage.input_tokens === "number") {
          inputTokens = chunkObj.usage.input_tokens;
        }
        if (typeof chunkObj.usage.completion_tokens === "number") {
          outputTokens = chunkObj.usage.completion_tokens;
        } else if (typeof chunkObj.usage.output_tokens === "number") {
          outputTokens = chunkObj.usage.output_tokens;
        }
      }

      const choice = chunkObj.choices?.[0];
      if (!choice) return;

      const delta = choice.delta;
      if (!delta) return;

      if (delta.reasoning_content || delta.reasoning) {
        const text = delta.reasoning_content || delta.reasoning;
        if (currentBlockType !== "thinking") {
          closeCurrentBlock();
          callbacks.onEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "thinking", thinking: "" },
          });
          currentBlockType = "thinking";
        }
        callbacks.onEvent("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "thinking_delta", thinking: text },
        });
      }

      if (delta.content) {
        if (currentBlockType !== "text") {
          closeCurrentBlock();
          callbacks.onEvent("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" },
          });
          currentBlockType = "text";
        }
        callbacks.onEvent("content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) {
            closeCurrentBlock();
            callbacks.onEvent("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id || `toolu_${Date.now()}`,
                name: tc.function.name,
                input: {},
              },
            });
            currentBlockType = "tool_use";
          }
          if (tc.function?.arguments) {
            callbacks.onEvent("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: {
                type: "input_json_delta",
                partial_json: tc.function.arguments,
              },
            });
          }
        }
      }

      if (choice.finish_reason) {
        closeCurrentBlock();
        if (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") {
          finishReason = "tool_use";
        } else if (choice.finish_reason === "length") {
          finishReason = "max_tokens";
        } else {
          finishReason = "end_turn";
        }
      }
    },

    finish() {
      closeCurrentBlock();
      callbacks.onEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: finishReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      callbacks.onEvent("message_stop", { type: "message_stop" });
      callbacks.onUsage(inputTokens, outputTokens);
    },
  };
}
