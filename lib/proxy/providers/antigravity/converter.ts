// OpenAI <-> Gemini format converter for Antigravity

import type { ChatCompletionRequest } from "../types";
import type { RequestPayload, ModelFamily } from "./transform/types";

/**
 * Convert OpenAI messages to Gemini format
 */
export function convertOpenAIToGemini(
  request: ChatCompletionRequest
): RequestPayload {
  const contents: Array<Record<string, unknown>> = [];
  let systemInstruction: unknown = undefined;

  for (const message of request.messages) {
    if (message.role === "system") {
      // System messages become systemInstruction
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((c) => c.type === "text")
                .map((c) => (c as { text?: string }).text ?? "")
                .join("\n")
            : "";

      if (systemInstruction) {
        // Append to existing
        const existing = systemInstruction as { parts: Array<{ text: string }> };
        existing.parts.push({ text });
      } else {
        systemInstruction = { parts: [{ text }] };
      }
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];

    if (typeof message.content === "string") {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const content of message.content) {
        if (content.type === "text") {
          parts.push({ text: (content as { text?: string }).text ?? "" });
        } else if (content.type === "image_url") {
          const imageUrl = (content as { image_url?: { url?: string } }).image_url;
          if (imageUrl?.url) {
            if (imageUrl.url.startsWith("data:")) {
              // Base64 image
              const match = imageUrl.url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                parts.push({
                  inlineData: {
                    mimeType: match[1],
                    data: match[2],
                  },
                });
              }
            } else {
              // URL image
              parts.push({
                fileData: {
                  fileUri: imageUrl.url,
                },
              });
            }
          }
        }
      }
    }

    // Handle tool calls from assistant
    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const tc = toolCall as {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
        if (tc.function) {
          let args: unknown = {};
          try {
            args = JSON.parse(tc.function.arguments ?? "{}");
          } catch {
            args = {};
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
              id: tc.id,
            },
          });
        }
      }
    }

    // Handle tool response
    if (message.role === "tool" && message.tool_call_id) {
      parts.push({
        functionResponse: {
          name: message.name ?? "unknown",
          id: message.tool_call_id,
          response: {
            result: message.content,
          },
        },
      });
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  // Build Gemini payload
  const payload: RequestPayload = {
    contents,
  };

  if (systemInstruction) {
    payload.systemInstruction = systemInstruction;
  }

  // Generation config
  const generationConfig: Record<string, unknown> = {};

  if (request.temperature !== undefined) {
    generationConfig.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    generationConfig.topP = request.top_p;
  }
  if (request.max_tokens !== undefined) {
    generationConfig.maxOutputTokens = request.max_tokens;
  }
  if (request.stop) {
    generationConfig.stopSequences = Array.isArray(request.stop)
      ? request.stop
      : [request.stop];
  }

  // Thinking config from extended parameters
  if (request.reasoning_effort || request.thinking_budget) {
    const thinkingConfig: Record<string, unknown> = {};

    if (request.thinking_budget) {
      thinkingConfig.thinkingBudget = request.thinking_budget;
    } else if (request.reasoning_effort) {
      // Map reasoning_effort to thinkingLevel
      const levelMap: Record<string, string> = {
        none: "none",
        low: "low",
        medium: "medium",
        high: "high",
      };
      thinkingConfig.thinkingLevel = levelMap[request.reasoning_effort] ?? "medium";
    }

    if (request.include_thoughts !== undefined) {
      thinkingConfig.include_thoughts = request.include_thoughts;
    }

    generationConfig.thinkingConfig = thinkingConfig;
  }

  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  // Tools
  if (request.tools && request.tools.length > 0) {
    const functionDeclarations = request.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }));

    if (functionDeclarations.length > 0) {
      payload.tools = [{ functionDeclarations }];
    }
  }

  return payload;
}

/**
 * Determine model family from model name
 */
export function getModelFamily(model: string): ModelFamily {
  return model.includes("claude")
    ? "claude"
    : model.includes("flash")
      ? "gemini-flash"
      : "gemini-pro";
}

/**
 * Convert Gemini response to OpenAI format (non-streaming)
 */
export function convertGeminiToOpenAI(
  geminiResponse: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const candidates = geminiResponse.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  const usageMetadata = geminiResponse.usageMetadata as
    | Record<string, unknown>
    | undefined;

  const choices: Array<Record<string, unknown>> = [];

  if (candidates && candidates.length > 0) {
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const content = candidate.content as Record<string, unknown> | undefined;
      const parts = content?.parts as Array<Record<string, unknown>> | undefined;

      let textContent = "";
      const toolCalls: Array<Record<string, unknown>> = [];
      let reasoningContent = "";

      if (parts) {
        for (const part of parts) {
          if (part.thought === true && typeof part.text === "string") {
            reasoningContent += part.text;
          } else if (typeof part.text === "string") {
            textContent += part.text;
          } else if (part.functionCall) {
            const fc = part.functionCall as Record<string, unknown>;
            toolCalls.push({
              id: fc.id ?? `call_${crypto.randomUUID()}`,
              type: "function",
              function: {
                name: fc.name,
                arguments: JSON.stringify(fc.args ?? {}),
              },
            });
          }
        }
      }

      const message: Record<string, unknown> = {
        role: "assistant",
        content: textContent || null,
      };

      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      if (reasoningContent) {
        message.reasoning_content = reasoningContent;
      }

      const finishReason = candidate.finishReason as string | undefined;
      let openaiFinishReason = "stop";
      if (finishReason === "STOP") {
        openaiFinishReason = "stop";
      } else if (finishReason === "MAX_TOKENS") {
        openaiFinishReason = "length";
      } else if (finishReason === "TOOL_CALLS" || toolCalls.length > 0) {
        openaiFinishReason = "tool_calls";
      }

      choices.push({
        index: i,
        message,
        finish_reason: openaiFinishReason,
      });
    }
  }

  const usage: Record<string, unknown> = {
    prompt_tokens: usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: usageMetadata?.candidatesTokenCount ?? 0,
    total_tokens: usageMetadata?.totalTokenCount ?? 0,
  };

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices,
    usage,
  };
}

/**
 * Create SSE transform stream for converting Gemini SSE to OpenAI SSE format
 *
 * State tracking for proper OpenAI streaming format:
 * - isFirstChunk: Ensures 'role: assistant' is sent on first delta
 * - toolCallIndex: Tracks index for multiple tool calls (0, 1, 2...)
 * - hasToolCalls: Determines if finish_reason should be 'tool_calls'
 * - toolCallIds: Stores stable IDs per tool call name within this request
 * - completionId: Single ID for entire completion (not per-chunk)
 */
export function createGeminiToOpenAISseTransform(
  model: string
): TransformStream<string, string> {
  // State variables for tracking across chunks
  let isFirstChunk = true;
  let toolCallIndex = 0;
  let hasToolCalls = false;
  const toolCallIds = new Map<string, string>();
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return new TransformStream<string, string>({
    transform(line, controller) {
      if (!line.startsWith("data:")) {
        controller.enqueue(line);
        return;
      }

      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") {
        controller.enqueue(line);
        return;
      }

      try {
        const geminiChunk = JSON.parse(json) as Record<string, unknown>;
        const candidates = geminiChunk.candidates as
          | Array<Record<string, unknown>>
          | undefined;

        if (!candidates || candidates.length === 0) {
          return;
        }

        const candidate = candidates[0];
        const content = candidate.content as Record<string, unknown> | undefined;
        const parts = content?.parts as Array<Record<string, unknown>> | undefined;

        if (!parts || parts.length === 0) {
          // Check for finish reason even if no parts (final chunk case)
          const candidateFinishReason = candidate.finishReason as string | undefined;
          if (candidateFinishReason) {
            let openaiFinishReason = "stop";
            if (candidateFinishReason === "MAX_TOKENS") {
              openaiFinishReason = "length";
            } else if (hasToolCalls) {
              openaiFinishReason = "tool_calls";
            }

            const finalChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: openaiFinishReason,
                },
              ],
            };

            controller.enqueue(`data: ${JSON.stringify(finalChunk)}\n\n`);
          }
          return;
        }

        for (const part of parts) {
          const delta: Record<string, unknown> = {};

          if (part.thought === true && typeof part.text === "string") {
            // Reasoning/thinking content
            if (isFirstChunk) {
              delta.role = "assistant";
              isFirstChunk = false;
            }
            delta.reasoning_content = part.text;
          } else if (typeof part.text === "string") {
            // Regular text content
            if (isFirstChunk) {
              delta.role = "assistant";
              isFirstChunk = false;
            }
            delta.content = part.text;
          } else if (part.functionCall) {
            // Tool/function call
            const fc = part.functionCall as Record<string, unknown>;
            const funcName = fc.name as string;

            // Get or create stable ID for this tool call
            let toolId = fc.id as string | undefined;
            if (!toolId) {
              toolId = toolCallIds.get(funcName);
              if (!toolId) {
                toolId = `call_${crypto.randomUUID()}`;
                toolCallIds.set(funcName, toolId);
              }
            }

            if (isFirstChunk) {
              delta.role = "assistant";
              isFirstChunk = false;
            }

            delta.tool_calls = [
              {
                index: toolCallIndex,
                id: toolId,
                type: "function",
                function: {
                  name: funcName,
                  arguments: JSON.stringify(fc.args ?? {}),
                },
              },
            ];

            toolCallIndex++;
            hasToolCalls = true;
          }

          if (Object.keys(delta).length === 0) {
            continue;
          }

          const openaiChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: null,
              },
            ],
          };

          controller.enqueue(`data: ${JSON.stringify(openaiChunk)}\n\n`);
        }

        // Check for finish reason from Gemini
        const candidateFinishReason = candidate.finishReason as string | undefined;
        if (candidateFinishReason) {
          let openaiFinishReason = "stop";
          if (candidateFinishReason === "MAX_TOKENS") {
            openaiFinishReason = "length";
          } else if (hasToolCalls) {
            openaiFinishReason = "tool_calls";
          }

          const finalChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: openaiFinishReason,
              },
            ],
          };

          controller.enqueue(`data: ${JSON.stringify(finalChunk)}\n\n`);
        }
      } catch {
        // Skip malformed chunks
      }
    },
    flush(controller) {
      controller.enqueue("data: [DONE]\n\n");
    },
  });
}

/**
 * Create SSE transform stream that unwraps Antigravity response wrapper
 */
export function createAntigravityUnwrapTransform(): TransformStream<
  string,
  string
> {
  let buffer = "";

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          controller.enqueue(line + "\n\n");
          continue;
        }

        const json = line.slice(5).trim();
        if (!json) {
          controller.enqueue(line + "\n\n");
          continue;
        }

        try {
          let parsed = JSON.parse(json) as unknown;

          // Handle array-wrapped responses
          if (Array.isArray(parsed)) {
            parsed = parsed.find((item) => typeof item === "object" && item !== null);
          }

          if (!parsed || typeof parsed !== "object") {
            controller.enqueue(line + "\n\n");
            continue;
          }

          const body = parsed as Record<string, unknown>;

          // Unwrap response if wrapped
          if (body.response !== undefined) {
            controller.enqueue(`data: ${JSON.stringify(body.response)}\n\n`);
          } else {
            controller.enqueue(line + "\n\n");
          }
        } catch {
          controller.enqueue(line + "\n\n");
        }
      }
    },
    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(buffer);
      }
    },
  });
}
