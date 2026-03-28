import type { ProviderAccount } from "../../../db/schema.js";
import { encrypt, decrypt } from "../../../encryption.js";
import { db } from "../../../db/index.js";
import { providerAccount } from "../../../db/schema.js";
import { eq } from "drizzle-orm";
import type {
  Provider,
  ProviderConfig,
  OAuthResult,
  ChatCompletionRequest,
} from "../types.js";
import { DEFAULT_PROVIDER_TIMEOUTS } from "../types.js";
import { fetchWithTimeout } from "../../timeout.js";
import { getAdaptiveTimeout } from "../../adaptive-timeout.js";
import {
  COPILOT_CLIENT_ID,
  COPILOT_DEVICE_CODE_ENDPOINT,
  COPILOT_TOKEN_ENDPOINT,
  COPILOT_API_BASE_URL,
  COPILOT_USER_ENDPOINT,
  COPILOT_SCOPE,
  COPILOT_SUPPORTED_PARAMS,
  COPILOT_OPENCODE_USER_AGENT,
  COPILOT_OPENCODE_INTENT,
  COPILOT_POLLING_INTERVAL,
  COPILOT_DEVICE_CODE_EXPIRY,
  COPILOT_REFRESH_BUFFER_SECONDS,
} from "./constants.js";
import { getUpstreamModelName, getProviderModelSet, MODEL_REGISTRY, resolveModelAlias } from "../../models.js";
import { convertImageUrlsToBase64, convertResponsesInputImageUrlsToBase64 } from "../../image-utils.js";
import {
  convertResponsesInputToChatMessages,
  getCopilotSystemToolMode,
  injectCopilotChatSystemTool,
  injectCopilotResponsesSystemTool,
} from "./injection.js";

interface CopilotDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface CopilotTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

/** Safety margin (seconds) added to every polling interval to prevent clock-skew issues in VMs/WSL. */
const POLLING_SAFETY_MARGIN_SECONDS = 3;

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = COPILOT_REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

function buildRequestPayload(
  params: Record<string, unknown>,
  forceStream?: boolean
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(params)) {
    if (COPILOT_SUPPORTED_PARAMS.has(key) && value !== undefined) {
      payload[key] = value;
    }
  }

  if (forceStream !== undefined) {
    payload.stream = forceStream;
  } else if (payload.stream === undefined) {
    payload.stream = true;
  }

  if (payload.stream === true) {
    payload.stream_options = { include_usage: true };
  }

  return payload;
}

function resolveCopilotModel(model: string): string {
  const normalizedModel = model.startsWith("copilot/")
    ? model.split("/", 2)[1] || model
    : model;

  return getUpstreamModelName(normalizedModel, "copilot");
}

/**
 * Check if a model is a reasoning model based on the TOML registry metadata.
 * Non-reasoning models (e.g. gpt-4.1) do not accept reasoning_effort or reasoning params.
 */
function isReasoningModel(model: string): boolean {
  const canonical = resolveModelAlias(model);
  const info = MODEL_REGISTRY[canonical];
  return !!info?.meta?.reasoning;
}

/**
 * Check if a model requires the Responses API on GitHub Copilot.
 * Codex models and gpt-5.4+ are not accessible via /chat/completions
 * on Copilot's API.
 */
function requiresCopilotResponsesApi(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("codex") || lower.startsWith("gpt-5.4");
}

/**
 * Extract system/developer instructions from Chat Completions messages.
 */
function extractInstructionsFromChatMessages(
  messages: ChatCompletionRequest["messages"]
): string | undefined {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "system" && msg.role !== "developer") continue;
    const text = typeof msg.content === "string" ? msg.content.trim() : "";
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Convert a Chat Completions `image_url` content block to a Responses API
 * `input_image` block.
 */
function convertImageUrlBlock(
  block: { type: string; [key: string]: unknown }
): { type: string; [key: string]: unknown } {
  const imageUrlValue = block.image_url;

  if (typeof imageUrlValue === "string") {
    const { image_url, ...rest } = block;
    return { ...rest, type: "input_image", image_url };
  }

  if (imageUrlValue && typeof imageUrlValue === "object") {
    const nested = imageUrlValue as Record<string, unknown>;
    const url = typeof nested.url === "string" ? nested.url : "";
    const detail = nested.detail ?? block.detail;
    const { image_url: _img, detail: _det, ...rest } = block;
    return {
      ...rest,
      type: "input_image",
      image_url: url,
      ...(detail !== undefined ? { detail } : {}),
    };
  }

  return { ...block, type: "input_image" };
}

/**
 * Normalize Chat Completions content block types for Responses API.
 *
 * Chat Completions uses `text` and `image_url` block types while Responses API
 * expects `input_text`/`output_text` and `input_image`.
 */
function convertMessageContentForResponses(
  content: string | Array<{ type: string; [key: string]: unknown }>,
  role: string
): string | Array<{ type: string; [key: string]: unknown }> {
  if (!Array.isArray(content)) {
    return content;
  }

  const targetTextType = role === "assistant" ? "output_text" : "input_text";

  return content.map((block) => {
    if (block.type === "text") {
      return { ...block, type: targetTextType };
    }

    if (block.type === "image_url") {
      return convertImageUrlBlock(block);
    }

    return block;
  });
}

/**
 * Normalize Responses API input[] payloads coming from passthrough callers.
 * Ensures message content blocks never contain Chat Completions-only types.
 */
function normalizeResponsesInputForCopilot(
  input: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return input.map((item) => {
    if (item.type !== "message") {
      return item;
    }

    const content = item.content;
    if (!Array.isArray(content)) {
      return item;
    }

    const role = typeof item.role === "string" ? item.role : "user";

    return {
      ...item,
      content: convertMessageContentForResponses(
        content as Array<{ type: string; [key: string]: unknown }>,
        role
      ),
    };
  });
}

/**
 * Convert Chat Completions messages[] to Responses API input[] items.
 */
function convertChatMessagesToResponsesInput(
  messages: ChatCompletionRequest["messages"]
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer":
        input.push({
          type: "message",
          role: "developer",
          content: convertMessageContentForResponses(msg.content, "developer"),
        });
        break;

      case "user":
        input.push({
          type: "message",
          role: "user",
          content: convertMessageContentForResponses(msg.content, "user"),
        });
        break;

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) {
            input.push({
              type: "message",
              role: "assistant",
              content: convertMessageContentForResponses(msg.content, "assistant"),
            });
          }
          for (const tc of msg.tool_calls) {
            const toolCall = tc as {
              id: string;
              type: string;
              function: { name: string; arguments: string };
            };
            input.push({
              type: "function_call",
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            });
          }
        } else {
          input.push({
            type: "message",
            role: "assistant",
            content: convertMessageContentForResponses(msg.content, "assistant"),
          });
        }
        break;

      case "tool":
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || "",
          output:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
        });
        break;

      default:
        input.push({
          type: "message",
          role: msg.role,
          content: convertMessageContentForResponses(msg.content, msg.role),
        });
    }
  }

  return input;
}

/**
 * Convert Chat Completions tools to Responses API tools format.
 */
function convertToolsToResponsesFormat(
  tools?: ChatCompletionRequest["tools"]
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description || "",
    parameters: tool.function.parameters || { type: "object", properties: {} },
  }));
}

/**
 * Build a Responses API payload from a Chat Completions request body.
 * Intentionally omits sampling params (temperature, top_p, etc.) that are
 * unsupported by codex models with reasoning enabled.
 */
function buildCopilotResponsesPayload(
  body: ChatCompletionRequest,
  stream: boolean
): Record<string, unknown> {
  const explicitInstructions =
    typeof body.instructions === "string" ? body.instructions.trim() : undefined;
  const derivedInstructions = extractInstructionsFromChatMessages(body.messages);
  const instructions = explicitInstructions || derivedInstructions;

  const input =
    Array.isArray(body._responsesInput) && body._responsesInput.length > 0
      ? normalizeResponsesInputForCopilot(body._responsesInput)
      : convertChatMessagesToResponsesInput(body.messages);

  const payload: Record<string, unknown> = {
    model: body.model,
    input,
    stream,
  };

  if (instructions) {
    payload.instructions = instructions;
  }

  const tools = convertToolsToResponsesFormat(body.tools);
  if (tools) {
    payload.tools = tools;
  }

  if (body.tool_choice !== undefined) {
    payload.tool_choice = body.tool_choice;
  }

  // Reasoning config
  if (body.reasoning && typeof body.reasoning === "object") {
    payload.reasoning = body.reasoning;
  } else if (body.reasoning_effort) {
    payload.reasoning = { effort: body.reasoning_effort };
  }

  // max_output_tokens (Responses API equivalent of max_tokens)
  if (body.max_tokens !== undefined) {
    payload.max_output_tokens = body.max_tokens;
  }

  return payload;
}

/**
 * Generate a unique Chat Completions ID.
 */
function generateChatCompletionId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "chatcmpl-";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Create a TransformStream that converts Responses API SSE events
 * into Chat Completions SSE format.
 */
function createCopilotResponsesToChatCompletionsStream(
  model: string
): TransformStream<string, string> {
  const completionId = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let sentRole = false;
  let sentDone = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let currentFunctionCallId: string | null = null;
  let functionCallIndex = 0;

  function makeChatChunk(
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  ): string {
    const chunk: Record<string, unknown> = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) {
      chunk.usage = usage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) continue;
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") {
          if (!sentDone) {
            sentDone = true;
            controller.enqueue("data: [DONE]\n\n");
          }
          continue;
        }

        try {
          const event = JSON.parse(jsonStr);
          const eventType = event.type;

          switch (eventType) {
            case "response.output_text.delta": {
              if (!sentRole) {
                controller.enqueue(makeChatChunk({ role: "assistant", content: "" }));
                sentRole = true;
              }
              if (event.delta) {
                controller.enqueue(makeChatChunk({ content: event.delta }));
              }
              break;
            }

            case "response.reasoning.delta":
            case "response.reasoning_summary_text.delta": {
              if (!sentRole) {
                controller.enqueue(makeChatChunk({ role: "assistant", content: "" }));
                sentRole = true;
              }
              if (event.delta) {
                controller.enqueue(makeChatChunk({ reasoning_content: event.delta }));
              }
              break;
            }

            case "response.output_item.added": {
              if (event.item?.type === "function_call") {
                if (!sentRole) {
                  controller.enqueue(makeChatChunk({ role: "assistant" }));
                  sentRole = true;
                }
                const fcName = event.item.name || "";
                currentFunctionCallId =
                  event.item.call_id || event.item.id || `call_${Date.now()}`;
                controller.enqueue(
                  makeChatChunk({
                    tool_calls: [
                      {
                        index: functionCallIndex,
                        id: currentFunctionCallId,
                        type: "function",
                        function: { name: fcName, arguments: "" },
                      },
                    ],
                  })
                );
              }
              break;
            }

            case "response.function_call_arguments.delta": {
              if (event.delta) {
                controller.enqueue(
                  makeChatChunk({
                    tool_calls: [
                      {
                        index: functionCallIndex,
                        function: { arguments: event.delta },
                      },
                    ],
                  })
                );
              }
              break;
            }

            case "response.function_call_arguments.done":
            case "response.output_item.done": {
              if (
                event.item?.type === "function_call" ||
                eventType === "response.function_call_arguments.done"
              ) {
                functionCallIndex++;
                currentFunctionCallId = null;
              }
              break;
            }

            case "response.completed":
            case "response.done": {
              const resp = event.response || event;
              if (resp.usage) {
                inputTokens =
                  resp.usage.input_tokens || resp.usage.prompt_tokens || 0;
                outputTokens =
                  resp.usage.output_tokens || resp.usage.completion_tokens || 0;
              }

              let finishReason = "stop";
              if (resp.status === "incomplete") finishReason = "length";
              if (functionCallIndex > 0) finishReason = "tool_calls";

              controller.enqueue(
                makeChatChunk({}, finishReason, {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                })
              );
              if (!sentDone) {
                sentDone = true;
                controller.enqueue("data: [DONE]\n\n");
              }
              break;
            }

            default:
              break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    },
    flush(controller) {
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]" && !sentDone) {
            controller.enqueue("data: [DONE]\n\n");
          }
        }
      }
    },
  });
}

/**
 * Convert a non-streaming Responses API response to Chat Completions format.
 */
function convertCopilotResponsesToCompletion(
  responsesData: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const completionId = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const output = (responsesData.output as Array<Record<string, unknown>>) || [];
  let content = "";
  let reasoningContent = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  let toolCallIndex = 0;

  for (const item of output) {
    if (item.type === "message") {
      const itemContent = item.content as Array<Record<string, unknown>>;
      if (Array.isArray(itemContent)) {
        for (const part of itemContent) {
          if (part.type === "output_text") {
            content += (part.text as string) || "";
          }
        }
      }
    } else if (item.type === "reasoning") {
      const summary = item.summary;
      if (Array.isArray(summary)) {
        for (const part of summary) {
          const text =
            typeof part === "string"
              ? part
              : (part as { text?: string })?.text || "";
          if (text) reasoningContent += (reasoningContent ? "\n" : "") + text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id:
          (item.call_id as string) ||
          (item.id as string) ||
          `call_${toolCallIndex}`,
        type: "function",
        function: {
          name: item.name as string,
          arguments: (item.arguments as string) || "{}",
        },
      });
      toolCallIndex++;
    }
  }

  const usage = responsesData.usage as Record<string, number> | undefined;
  const promptTokens = usage?.input_tokens || usage?.prompt_tokens || 0;
  const completionTokens = usage?.output_tokens || usage?.completion_tokens || 0;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  let finishReason = "stop";
  if ((responsesData.status as string) === "incomplete") finishReason = "length";
  if (toolCalls.length > 0) finishReason = "tool_calls";

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function hasVisionInResponsesInput(
  input: Array<Record<string, unknown>> | undefined
): boolean {
  if (!Array.isArray(input)) {
    return false;
  }

  return input.some((item) => {
    const content = item.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }

      return (part as { type?: unknown }).type === "input_image";
    });
  });
}

function hasVisionInChatMessages(messages: ChatCompletionRequest["messages"]): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }

  return messages.some((message) => {
    const content = message.content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }

      const type = (part as { type?: unknown }).type;
      return type === "image_url" || type === "image";
    });
  });
}

function isCopilotVisionRequest(body: ChatCompletionRequest): boolean {
  return (
    hasVisionInResponsesInput(body._responsesInput) ||
    hasVisionInChatMessages(body.messages)
  );
}

function buildCopilotHeaders(
  accessToken: string,
  stream: boolean,
  initiator: "user" | "agent",
  visionRequest: boolean
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-initiator": initiator,
    "User-Agent": COPILOT_OPENCODE_USER_AGENT,
    Authorization: `Bearer ${accessToken}`,
    "Openai-Intent": COPILOT_OPENCODE_INTENT,
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
  };

  if (visionRequest) {
    headers["Copilot-Vision-Request"] = "true";
  }

  return headers;
}

async function fetchCopilotIdentity(accessToken: string): Promise<string> {
  try {
    const response = await fetch(COPILOT_USER_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": COPILOT_OPENCODE_USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return "";
    }

    const user = (await response.json()) as { login?: string; email?: string };
    return (user.email || user.login || "").trim();
  } catch {
    return "";
  }
}

function normalizeTokenExpiry(expiresIn?: number): Date {
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return new Date(Date.now() + expiresIn * 1000);
  }

  return new Date("2100-01-01T00:00:00.000Z");
}

export const copilotConfig: ProviderConfig = {
  name: "copilot",
  displayName: "GitHub Copilot",
  supportedModels: getProviderModelSet("copilot"),
  timeouts: DEFAULT_PROVIDER_TIMEOUTS,
};

export const copilotProvider: Provider = {
  config: copilotConfig,

  async prepareRequest(account, body, endpoint) {
    const mode = await getCopilotSystemToolMode(account.id);

    const preparedBody: ChatCompletionRequest = {
      ...body,
      _copilotXInitiator: mode.xInitiator,
    };

    if (!mode.injectSystemTool) {
      return preparedBody;
    }

    if (endpoint === "responses" && Array.isArray(preparedBody._responsesInput)) {
      const injectedResponsesInput = injectCopilotResponsesSystemTool(
        preparedBody._responsesInput as Array<Record<string, unknown>>
      );

      preparedBody._responsesInput = injectedResponsesInput;

      preparedBody.messages = convertResponsesInputToChatMessages(
        injectedResponsesInput,
        typeof preparedBody.instructions === "string"
          ? preparedBody.instructions
          : undefined
      ) as ChatCompletionRequest["messages"];

      return preparedBody;
    }

    if (Array.isArray(preparedBody.messages)) {
      preparedBody.messages = injectCopilotChatSystemTool(
        preparedBody.messages as Array<Record<string, unknown>>
      ) as ChatCompletionRequest["messages"];
    }

    return preparedBody;
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error(
      "Copilot uses Device Code Flow. Use initiateCopilotDeviceCodeFlow() instead."
    );
  },

  async exchangeCode(code: string): Promise<OAuthResult> {
    const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": COPILOT_OPENCODE_USER_AGENT,
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Copilot token exchange failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as CopilotTokenResponse;
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Missing access token");
    }

    const identity = await fetchCopilotIdentity(tokenData.access_token);

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || tokenData.access_token,
      expiresAt: normalizeTokenExpiry(tokenData.expires_in),
      email: identity,
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": COPILOT_OPENCODE_USER_AGENT,
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Copilot token refresh failed: ${response.status} ${errorText}`);
    }

    const tokenData = await response.json() as CopilotTokenResponse;
    if (!tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || "Missing access token");
    }

    const identity = await fetchCopilotIdentity(tokenData.access_token);

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || refreshToken,
      expiresAt: normalizeTokenExpiry(tokenData.expires_in),
      email: identity,
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (isTokenExpired(account.expiresAt) && refreshTokenValue) {
      try {
        const refreshed = await this.refreshToken(refreshTokenValue);

        await db
          .update(providerAccount)
          .set({
            accessToken: encrypt(refreshed.accessToken),
            refreshToken: encrypt(refreshed.refreshToken),
            expiresAt: refreshed.expiresAt,
            ...(refreshed.email ? { email: refreshed.email } : {}),
          })
          .where(eq(providerAccount.id, account.id));

        accessToken = refreshed.accessToken;
      } catch (error) {
        console.error(`Failed to refresh Copilot token for account ${account.id}:`, error);
        if (new Date() >= account.expiresAt) {
          throw error;
        }
      }
    }

    return accessToken;
  },

  async makeRequest(
    accessToken: string,
    _account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const modelName = body.model.includes("/") ? body.model.split("/").pop()! : body.model;
    const upstreamModel = resolveCopilotModel(modelName);
    const xInitiator = body._copilotXInitiator === "agent" ? "agent" : "user";

    // Copilot rejects external image URLs — convert to base64 data URIs.
    // Must happen before isCopilotVisionRequest() so the vision header is
    // still set correctly (data URIs are still detected as image content).
    if (Array.isArray(body.messages)) {
      body = { ...body, messages: await convertImageUrlsToBase64(body.messages) };
    }
    if (Array.isArray(body._responsesInput) && body._responsesInput.length > 0) {
      body = {
        ...body,
        _responsesInput: await convertResponsesInputImageUrlsToBase64(
          body._responsesInput as Array<Record<string, unknown>>
        ),
      };
    }

    const visionRequest = isCopilotVisionRequest(body);

    const fallbackMs = stream
      ? copilotConfig.timeouts.streamMs
      : copilotConfig.timeouts.nonStreamMs;
    const timeoutMs = await getAdaptiveTimeout(
      copilotConfig.name, body.model, stream, fallbackMs
    );

    // Codex models require the Responses API endpoint on GitHub Copilot
    if (requiresCopilotResponsesApi(upstreamModel)) {
      const payload = buildCopilotResponsesPayload(
        { ...body, model: upstreamModel },
        stream
      );

      const response = await fetchWithTimeout(
        `${COPILOT_API_BASE_URL}/responses`,
        {
          method: "POST",
          headers: buildCopilotHeaders(accessToken, stream, xInitiator, visionRequest),
          body: JSON.stringify(payload),
        },
        timeoutMs
      );

      // Transform streaming Responses API SSE back to Chat Completions SSE
      if (stream && response.ok && response.body) {
        const converter = createCopilotResponsesToChatCompletionsStream(upstreamModel);
        const transformedBody = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(converter)
          .pipeThrough(new TextEncoderStream());

        return new Response(transformedBody, {
          status: response.status,
          statusText: response.statusText,
          headers: new Headers({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          }),
        });
      }

      // Transform non-streaming Responses API JSON back to Chat Completions
      if (!stream && response.ok) {
        const responsesData = (await response.json()) as Record<string, unknown>;
        const completionData = convertCopilotResponsesToCompletion(
          responsesData,
          upstreamModel
        );
        return new Response(JSON.stringify(completionData), {
          status: 200,
          headers: new Headers({ "Content-Type": "application/json" }),
        });
      }

      // Error responses pass through as-is
      return response;
    }

    // Regular models: use Chat Completions endpoint
    // Strip reasoning params for non-reasoning models (e.g. gpt-4.1) to avoid
    // "Unrecognized request argument" errors from the Copilot API.
    const chatBody: Record<string, unknown> = { ...body, model: upstreamModel };
    if (!isReasoningModel(modelName)) {
      delete chatBody.reasoning_effort;
      delete chatBody.reasoning;
    }
    const requestPayload = buildRequestPayload(chatBody, stream);

    return fetchWithTimeout(`${COPILOT_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: buildCopilotHeaders(accessToken, stream, xInitiator, visionRequest),
      body: JSON.stringify(requestPayload),
    }, timeoutMs);
  },
};

export async function initiateCopilotDeviceCodeFlow(): Promise<{
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresIn: number;
  interval: number;
}> {
  const response = await fetch(COPILOT_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": COPILOT_OPENCODE_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: COPILOT_SCOPE,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Copilot device code request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as CopilotDeviceCodeResponse;

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri,
    verificationUrlComplete: data.verification_uri_complete || data.verification_uri,
    expiresIn: data.expires_in || COPILOT_DEVICE_CODE_EXPIRY,
    interval: data.interval || COPILOT_POLLING_INTERVAL,
  };
}

export async function pollCopilotDeviceCodeAuthorization(
  deviceCode: string
): Promise<OAuthResult | { pending: true; retryAfterSeconds?: number } | { error: string }> {
  const response = await fetch(COPILOT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": COPILOT_OPENCODE_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { error: `Copilot auth failed (HTTP ${response.status}): ${errorText}` };
  }

  const data = await response.json() as CopilotTokenResponse;

  if (data.access_token) {
    const identity = await fetchCopilotIdentity(data.access_token);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || data.access_token,
      expiresAt: normalizeTokenExpiry(data.expires_in),
      email: identity,
    };
  }

  if (data.error === "authorization_pending") {
    return { pending: true };
  }

  // Per RFC 8628 §3.5, on "slow_down" the client MUST increase the polling
  // interval by 5 seconds (or use the server-provided interval).  We also add
  // a safety margin to guard against monotonic-clock drift in VMs/WSL.
  if (data.error === "slow_down") {
    const serverInterval = data.interval ?? COPILOT_POLLING_INTERVAL + 5;
    return {
      pending: true,
      retryAfterSeconds: serverInterval + POLLING_SAFETY_MARGIN_SECONDS,
    };
  }

  if (data.error === "expired_token") {
    return { error: "Device code expired. Please start again." };
  }

  if (data.error === "access_denied") {
    return { error: "Authorization was denied by the user." };
  }

  return {
    error: data.error_description || data.error || "Unknown authentication error",
  };
}
