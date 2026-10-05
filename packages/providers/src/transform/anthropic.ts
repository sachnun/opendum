import { defaultStringValue, randomId, stringValue } from "#providers/lib/helpers.ts";
import { convertImageURLsToBase64, type ImageFetch } from "#providers/lib/images.ts";
import {
  applyAnthropicThinking,
  anthropicMaxTokens,
  anthropicMessagesFromChat,
  anthropicStopSequences,
  anthropicToolChoiceFromChat,
  anthropicToolsFromChat,
} from "#providers/transform/anthropic-request.ts";
import { anthropicStopReasonToFinish, anthropicUsageToChatUsage } from "#providers/transform/anthropic-stream.ts";

export { anthropicMessagesSseToChatStream, anthropicUsageToChatUsage } from "#providers/transform/anthropic-stream.ts";

type Json = Record<string, unknown>;

export async function buildAnthropicMessagesPayload(
  body: Json,
  modelName: string,
  stream: boolean,
  imageFetch?: ImageFetch
): Promise<Json> {
  const messagesInput = Array.isArray(body.messages) ? body.messages : [];
  const messages = imageFetch
    ? await convertImageURLsToBase64(imageFetch, messagesInput)
    : messagesInput;
  const payload: Json = {
    model: modelName,
    stream,
    max_tokens: anthropicMaxTokens(body),
  };
  const { system, messages: converted } = anthropicMessagesFromChat(messages);
  if (system) payload.system = system;
  payload.messages = converted;
  if (body.temperature !== undefined && body.temperature !== null) payload.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) payload.top_p = body.top_p;
  const stop = anthropicStopSequences(body.stop);
  if (stop.length > 0) payload.stop_sequences = stop;
  const tools = anthropicToolsFromChat(body.tools);
  if (tools.length > 0) {
    payload.tools = tools;
    const choice = anthropicToolChoiceFromChat(body.tool_choice);
    if (choice) payload.tool_choice = choice;
  }
  applyAnthropicThinking(payload, body);
  return payload;
}

export function anthropicMessagesToChatCompletion(data: Json, model: string): Json {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  const blocks = Array.isArray(data.content) ? data.content : [];
  for (const raw of blocks) {
    const block = (raw ?? {}) as Json;
    switch (stringValue(block.type)) {
      case "text":
        content += stringValue(block.text);
        break;
      case "thinking":
        reasoning += stringValue(block.thinking);
        break;
      case "tool_use": {
        let args = "{}";
        if (block.input !== undefined && block.input !== null) {
          args = JSON.stringify(block.input);
        }
        toolCalls.push({
          id: defaultStringValue(stringValue(block.id), randomId("call")),
          type: "function",
          function: { name: stringValue(block.name), arguments: args },
        });
        break;
      }
      default:
        break;
    }
  }
  const message: Json = { role: "assistant", content: null };
  if (content) message.content = content;
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const finish = anthropicStopReasonToFinish(stringValue(data.stop_reason), toolCalls.length > 0);
  return {
    id: defaultStringValue(stringValue(data.id), randomId("chatcmpl")),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: defaultStringValue(model, stringValue(data.model)),
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: anthropicUsageToChatUsage(data.usage),
  };
}
