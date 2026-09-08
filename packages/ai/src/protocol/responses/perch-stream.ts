export interface PerchStreamCallbacks {
  onChunk(chunk: Record<string, unknown>): void;
  onDone(): void;
}

export function createPerchSSEToChatTransformer(
  model: string,
  callbacks: PerchStreamCallbacks,
  includeReasoning = true
) {
  const completionId = `chatcmpl_${Math.random().toString(36).slice(2)}`;
  let sentRole = false;
  let nextToolIndex = 0;
  const tools = new Map<string, { index: number; name: string; emittedArgs: boolean }>();

  function writeChunk(delta: Record<string, unknown>, finishReason: string | null = null, usage: any = null) {
    const chunk: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
    if (usage) {
      chunk.usage = usage;
    }
    callbacks.onChunk(chunk);
  }

  function ensureRole() {
    if (!sentRole) {
      writeChunk({ role: "assistant", content: "" }, null);
      sentRole = true;
    }
  }

  return {
    processEvent(event: any) {
      const type = event?.type;

      if (type === "reasoning_delta" && includeReasoning) {
        ensureRole();
        if (event.text) {
          writeChunk({ reasoning_content: event.text });
        }
      } else if (type === "answer_delta") {
        ensureRole();
        if (event.text) {
          writeChunk({ content: event.text });
        }
      } else if (type === "tool_call_delta" || type === "tool_use_end") {
        const sealed = type === "tool_use_end";
        const toolCalls = event.toolCalls || event.tool_calls || [];

        for (const call of toolCalls) {
          const id = call.id;
          if (!id) continue;

          let state = tools.get(id);
          if (!state) {
            ensureRole();
            state = { index: nextToolIndex++, name: call.name || "", emittedArgs: false };
            tools.set(id, state);
            writeChunk({
              tool_calls: [
                {
                  index: state.index,
                  id,
                  type: "function",
                  function: { name: state.name },
                },
              ],
            });
          }

          const args = call.rawArgumentsText || (sealed ? (typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments || {})) : "");
          if (args && (!sealed || !state.emittedArgs)) {
            state.emittedArgs = true;
            writeChunk({
              tool_calls: [
                {
                  index: state.index,
                  function: { arguments: args },
                },
              ],
            });
          }
        }
      } else if (type === "done") {
        let finish = "stop";
        if (tools.size > 0 && event.ok !== false) {
          finish = "tool_calls";
        }

        let usage: any = null;
        if (event.usage) {
          const promptTokens = (event.usage.inputTokens || 0) + (event.usage.cacheReadInputTokens || 0);
          usage = {
            prompt_tokens: promptTokens,
            completion_tokens: event.usage.outputTokens || 0,
            total_tokens: promptTokens + (event.usage.outputTokens || 0),
          };
        }

        writeChunk({}, finish, usage);
        callbacks.onDone();
      }
    },
  };
}
