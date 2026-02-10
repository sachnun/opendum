// Codex Provider Implementation
// Uses Device Code Flow for OAuth via auth.openai.com
// API uses Responses API format, but we convert to/from Chat Completions format

import type { ProviderAccount } from "@prisma/client";
import { encrypt, decrypt } from "@/lib/encryption";
import { prisma } from "@/lib/db";
import type {
  Provider,
  ProviderConfig,
  OAuthResult,
  ChatCompletionRequest,
} from "../types";
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_CODE_ENDPOINT,
  CODEX_DEVICE_POLL_ENDPOINT,
  CODEX_TOKEN_ENDPOINT,
  CODEX_REDIRECT_URI,
  CODEX_DEVICE_VERIFICATION_URL,
  CODEX_API_BASE_URL,
  CODEX_MODELS,
  CODEX_SUPPORTED_PARAMS,
  CODEX_REFRESH_BUFFER_SECONDS,
  CODEX_ORIGINATOR,
} from "./constants";
import { updateCodexQuotaFromHeaders } from "./quota";

// ============================================================
// Types
// ============================================================

/**
 * Device code initiation response
 */
export interface CodexDeviceCodeResponse {
  device_auth_id: string;
  user_code: string;
  expires_in?: number | string;
  expires_at?: string;
  interval?: number | string;
}

/**
 * Device code poll response (when user has authorized)
 */
interface CodexPollSuccessResponse {
  authorization_code?: string;
  code_verifier?: string;
}

/**
 * Token response from auth.openai.com/oauth/token
 */
interface CodexTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
  token_type: string;
}

/**
 * Responses API input item
 */
interface ResponsesInputItem {
  type: string;
  role?: string;
  content?: string | Array<{ type: string; [key: string]: unknown }>;
  name?: string;
  call_id?: string;
  output?: string;
  id?: string;
  arguments?: string;
  status?: string;
  [key: string]: unknown;
}

const DEFAULT_CODEX_INSTRUCTIONS =
  "You are Codex, an expert coding assistant.";

function setIfCodexParamSupported(
  payload: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }

  if (CODEX_SUPPORTED_PARAMS.has(key)) {
    payload[key] = value;
  }
}

function filterSupportedCodexPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) {
      continue;
    }

    if (CODEX_SUPPORTED_PARAMS.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}

// ============================================================
// PKCE Utilities
// ============================================================

/**
 * Generate PKCE code verifier
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Generate PKCE code challenge from verifier
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ============================================================
// JWT Parsing
// ============================================================

/**
 * Normalize JWT value into a non-empty string.
 */
function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function extractOrganizationId(claims: Record<string, unknown> | null): string | null {
  if (!claims) {
    return null;
  }

  const organizations = claims.organizations;
  if (!Array.isArray(organizations)) {
    return null;
  }

  const normalizedOrganizations = organizations
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);

  const defaultOrganization = normalizedOrganizations.find(
    (organization) =>
      organization.is_default === true || organization.default === true
  );

  if (defaultOrganization) {
    const defaultOrganizationId = toNonEmptyString(defaultOrganization.id);
    if (defaultOrganizationId) {
      return defaultOrganizationId;
    }
  }

  for (const organization of normalizedOrganizations) {
    const organizationId = toNonEmptyString(organization.id);
    if (organizationId) {
      return organizationId;
    }
  }

  return null;
}

function parseJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;

    const payload = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);

    return asRecord(JSON.parse(atob(padded)));
  } catch {
    return null;
  }
}

function extractWorkspaceIdFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);

  const workspaceCandidates = [
    toNonEmptyString(authClaims?.chatgpt_workspace_id),
    toNonEmptyString(authClaims?.workspace_id),
    toNonEmptyString(authClaims?.organization_id),
    extractOrganizationId(authClaims),
    toNonEmptyString(decoded.chatgpt_workspace_id),
    toNonEmptyString(decoded.workspace_id),
    toNonEmptyString(decoded.organization_id),
    extractOrganizationId(decoded),
  ];

  for (const candidate of workspaceCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function extractAccountIdFromClaims(decoded: Record<string, unknown>): string | null {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);

  const accountCandidates = [
    toNonEmptyString(authClaims?.chatgpt_account_id),
    toNonEmptyString(decoded.chatgpt_account_id),
  ];

  for (const candidate of accountCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return extractWorkspaceIdFromClaims(decoded);
}

/**
 * Extract ChatGPT account ID from JWT token claims.
 * Falls back to workspace/org identifiers only when account ID is absent.
 */
function extractAccountIdFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  if (!decoded) {
    return null;
  }

  return extractAccountIdFromClaims(decoded);
}

/**
 * Extract ChatGPT workspace/org identifier from JWT token claims.
 */
function extractWorkspaceIdFromJwt(token: string): string | null {
  const decoded = parseJwtClaims(token);
  if (!decoded) {
    return null;
  }

  return extractWorkspaceIdFromClaims(decoded);
}

// ============================================================
// Chat Completions <-> Responses API Conversion
// ============================================================

/**
 * Convert Chat Completions messages[] to Responses API input[]
 */
function convertMessagesToInput(
  messages: ChatCompletionRequest["messages"]
): ResponsesInputItem[] {
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
      case "developer":
        // System/developer messages become input items with role
        input.push({
          type: "message",
          role: "developer",
          content:
            typeof msg.content === "string"
              ? msg.content
              : msg.content,
        });
        break;

      case "user":
        input.push({
          type: "message",
          role: "user",
          content:
            typeof msg.content === "string"
              ? msg.content
              : msg.content,
        });
        break;

      case "assistant":
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Assistant message with tool calls
          // First add any content as a message
          if (msg.content) {
            input.push({
              type: "message",
              role: "assistant",
              content:
                typeof msg.content === "string"
                  ? msg.content
                  : msg.content,
            });
          }
          // Then add each tool call as a function_call item
          for (const tc of msg.tool_calls) {
            const toolCall = tc as {
              id: string;
              type: string;
              function: { name: string; arguments: string };
            };
            input.push({
              type: "function_call",
              id: toolCall.id,
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            });
          }
        } else {
          input.push({
            type: "message",
            role: "assistant",
            content:
              typeof msg.content === "string"
                ? msg.content
                : msg.content,
          });
        }
        break;

      case "tool":
        // Tool result message
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
        // Pass through other roles as-is
        input.push({
          type: "message",
          role: msg.role,
          content:
            typeof msg.content === "string"
              ? msg.content
              : msg.content,
        });
    }
  }

  return input;
}

function extractTextContent(
  content: string | Array<{ type: string; [key: string]: unknown }>
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (typeof item.text === "string") {
      textParts.push(item.text);
      continue;
    }

    if (typeof item.input_text === "string") {
      textParts.push(item.input_text);
      continue;
    }

    if (typeof item.content === "string") {
      textParts.push(item.content);
    }
  }

  return textParts.join("\n").trim();
}

function extractInstructionsFromMessages(
  messages: ChatCompletionRequest["messages"]
): string | undefined {
  const instructionParts: string[] = [];

  for (const msg of messages) {
    if (msg.role !== "system" && msg.role !== "developer") {
      continue;
    }

    const content = extractTextContent(msg.content);
    if (content) {
      instructionParts.push(content);
    }
  }

  const combined = instructionParts.join("\n\n").trim();
  return combined || undefined;
}

/**
 * Convert Chat Completions tools to Responses API tools format
 */
function convertTools(
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
 * Build Responses API request body from Chat Completions format
 */
function buildResponsesApiPayload(
  body: ChatCompletionRequest,
  stream: boolean
): Record<string, unknown> {
  const explicitInstructions =
    typeof body.instructions === "string"
      ? body.instructions.trim()
      : undefined;
  const derivedInstructions = extractInstructionsFromMessages(body.messages);
  const responseInput =
    Array.isArray(body._responsesInput) && body._responsesInput.length > 0
      ? body._responsesInput
      : convertMessagesToInput(body.messages);
  const reasoningRequested =
    body._includeReasoning ?? !!(body.reasoning || body.reasoning_effort);
  const hasReasoningInputItem =
    Array.isArray(body._responsesInput) &&
    body._responsesInput.some(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as { type?: unknown }).type === "reasoning"
    );

  const payload: Record<string, unknown> = {};

  setIfCodexParamSupported(payload, "model", body.model);
  setIfCodexParamSupported(
    payload,
    "instructions",
    explicitInstructions || derivedInstructions || DEFAULT_CODEX_INSTRUCTIONS
  );
  setIfCodexParamSupported(payload, "store", false);
  setIfCodexParamSupported(payload, "input", responseInput);
  setIfCodexParamSupported(payload, "stream", stream);

  // Convert tools
  const tools = convertTools(body.tools);
  setIfCodexParamSupported(payload, "tools", tools);

  // Map parameters
  // Codex endpoint currently rejects sampling controls
  // like temperature/top_p; omit them to avoid 400 errors.
  setIfCodexParamSupported(payload, "tool_choice", body.tool_choice);

  // Reasoning config
  let reasoningConfig: Record<string, unknown> | undefined;
  if (body.reasoning && typeof body.reasoning === "object") {
    reasoningConfig = { ...body.reasoning };
  } else if (body.reasoning_effort) {
    reasoningConfig = {
      effort: body.reasoning_effort,
    };
  }

  if (reasoningConfig && reasoningRequested && reasoningConfig.summary === undefined) {
    reasoningConfig.summary = "auto";
  }

  if (reasoningConfig) {
    setIfCodexParamSupported(payload, "reasoning", reasoningConfig);
  }

  const include = new Set<string>(
    Array.isArray(body.include)
      ? body.include.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0
        )
      : []
  );
  const shouldRequestEncryptedReasoning =
    payload.store === false &&
    (reasoningRequested ||
      hasReasoningInputItem ||
      (Array.isArray(body.tools) && body.tools.length > 0));

  if (shouldRequestEncryptedReasoning) {
    include.add("reasoning.encrypted_content");
  }

  if (include.size > 0) {
    setIfCodexParamSupported(payload, "include", Array.from(include));
  }

  setIfCodexParamSupported(
    payload,
    "previous_response_id",
    body.previous_response_id
  );

  return filterSupportedCodexPayload(payload);
}

// ============================================================
// Streaming Response Conversion (Responses API SSE -> Chat Completions SSE)
// ============================================================

/**
 * Generate a unique chat completion ID
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
 * Create a TransformStream that converts Responses API SSE to Chat Completions SSE
 *
 * Responses API events:
 *   - response.output_text.delta: { delta: "text" }
 *   - response.function_call_arguments.delta: { delta: "text" }
 *   - response.completed / response.done: end of response
 *   - response.output_item.added: new output item (function_call, message, etc.)
 *
 * Chat Completions SSE events:
 *   data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"text"},"finish_reason":null}]}
 */
function createResponsesToChatCompletionsStream(
  model: string
): TransformStream<string, string> {
  const completionId = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let sentRole = false;
  let sentDone = false;
  let inputTokens = 0;
  let outputTokens = 0;
  // Track current function call state
  let currentFunctionCallName: string | null = null;
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
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;

      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith(":")) continue;

        // Handle event type lines
        if (trimmed.startsWith("event:")) continue;

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
            // Text content delta
            case "response.output_text.delta": {
              if (!sentRole) {
                controller.enqueue(
                  makeChatChunk({ role: "assistant", content: "" })
                );
                sentRole = true;
              }
              if (event.delta) {
                controller.enqueue(
                  makeChatChunk({ content: event.delta })
                );
              }
              break;
            }

            // Reasoning/thinking content
            case "response.reasoning.delta":
            case "response.reasoning_summary_text.delta": {
              if (!sentRole) {
                controller.enqueue(
                  makeChatChunk({ role: "assistant", content: "" })
                );
                sentRole = true;
              }
              if (event.delta) {
                controller.enqueue(
                  makeChatChunk({ reasoning_content: event.delta })
                );
              }
              break;
            }

            // Function call started
            case "response.output_item.added": {
              if (event.item?.type === "function_call") {
                if (!sentRole) {
                  controller.enqueue(
                    makeChatChunk({ role: "assistant" })
                  );
                  sentRole = true;
                }
                currentFunctionCallName = event.item.name || "";
                currentFunctionCallId =
                  event.item.call_id || event.item.id || `call_${Date.now()}`;

                // Emit tool_calls delta with function name
                controller.enqueue(
                  makeChatChunk({
                    tool_calls: [
                      {
                        index: functionCallIndex,
                        id: currentFunctionCallId,
                        type: "function",
                        function: {
                          name: currentFunctionCallName,
                          arguments: "",
                        },
                      },
                    ],
                  })
                );
              }
              break;
            }

            // Function call arguments delta
            case "response.function_call_arguments.delta": {
              if (event.delta) {
                controller.enqueue(
                  makeChatChunk({
                    tool_calls: [
                      {
                        index: functionCallIndex,
                        function: {
                          arguments: event.delta,
                        },
                      },
                    ],
                  })
                );
              }
              break;
            }

            // Function call done
            case "response.function_call_arguments.done":
            case "response.output_item.done": {
              if (
                event.item?.type === "function_call" ||
                eventType === "response.function_call_arguments.done"
              ) {
                functionCallIndex++;
                currentFunctionCallName = null;
                currentFunctionCallId = null;
              }
              break;
            }

            // Response completed
            case "response.completed":
            case "response.done": {
              const response = event.response || event;
              // Extract usage if available
              if (response.usage) {
                inputTokens =
                  response.usage.input_tokens ||
                  response.usage.prompt_tokens ||
                  0;
                outputTokens =
                  response.usage.output_tokens ||
                  response.usage.completion_tokens ||
                  0;
              }

              // Determine finish reason
              let finishReason = "stop";
              if (response.status === "incomplete") {
                finishReason = "length";
              }
              // Check if we had function calls
              if (functionCallIndex > 0) {
                finishReason = "tool_calls";
              }

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

            // Ignore other events (response.created, etc.)
            default:
              break;
          }
        } catch {
          // Skip unparseable lines
        }
      }
    },
    flush(controller) {
      // Process any remaining buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:")) {
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === "[DONE]") {
            controller.enqueue("data: [DONE]\n\n");
          }
        }
      }
    },
  });
}

function extractReasoningText(item: Record<string, unknown>): string {
  const summary = item.summary;
  const chunks: string[] = [];

  if (Array.isArray(summary)) {
    for (const part of summary) {
      if (typeof part === "string") {
        chunks.push(part);
        continue;
      }

      if (part && typeof part === "object") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          chunks.push(text);
        }
      }
    }
  }

  const text = item.text;
  if (typeof text === "string") {
    chunks.push(text);
  }

  return chunks.join("\n").trim();
}

/**
 * Convert a non-streaming Responses API response to Chat Completions format
 */
function convertResponseToCompletion(
  responsesData: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const completionId = generateChatCompletionId();
  const created = Math.floor(Date.now() / 1000);

  // Extract output items
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
      const extracted = extractReasoningText(item);
      if (extracted) {
        reasoningContent += reasoningContent ? `\n${extracted}` : extracted;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: (item.call_id as string) || (item.id as string) || `call_${toolCallIndex}`,
        type: "function",
        function: {
          name: item.name as string,
          arguments: (item.arguments as string) || "{}",
        },
      });
      toolCallIndex++;
    }
  }

  // Extract usage
  const usage = responsesData.usage as Record<string, number> | undefined;
  const inputTokens = usage?.input_tokens || usage?.prompt_tokens || 0;
  const outputTokens = usage?.output_tokens || usage?.completion_tokens || 0;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  let finishReason = "stop";
  if ((responsesData.status as string) === "incomplete") {
    finishReason = "length";
  }
  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  }

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

interface AccumulatedToolCall {
  id?: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Convert Chat Completions SSE text into a final non-streaming completion object
 */
function convertChatCompletionSseToCompletion(
  sseText: string,
  fallbackModel: string
): Record<string, unknown> {
  let completionId = generateChatCompletionId();
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let role = "assistant";
  let content = "";
  let reasoningContent = "";
  let finishReason: string | null = null;
  const toolCallsByIndex = new Map<number, AccumulatedToolCall>();

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;

  const lines = sseText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const chunk = JSON.parse(data) as {
        id?: string;
        created?: number;
        model?: string;
        choices?: Array<{
          delta?: Record<string, unknown>;
          finish_reason?: string | null;
        }>;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };

      if (chunk.id) {
        completionId = chunk.id;
      }
      if (typeof chunk.created === "number") {
        created = chunk.created;
      }
      if (typeof chunk.model === "string") {
        model = chunk.model;
      }

      const choice = chunk.choices?.[0];
      if (choice) {
        const delta = choice.delta || {};

        if (typeof delta.role === "string") {
          role = delta.role;
        }

        if (typeof delta.content === "string") {
          content += delta.content;
        }

        if (typeof delta.reasoning_content === "string") {
          reasoningContent += delta.reasoning_content;
        }

        const deltaToolCalls = Array.isArray(delta.tool_calls)
          ? (delta.tool_calls as Array<Record<string, unknown>>)
          : [];

        for (const toolCall of deltaToolCalls) {
          const index =
            typeof toolCall.index === "number" && Number.isFinite(toolCall.index)
              ? toolCall.index
              : 0;

          const existing = toolCallsByIndex.get(index) || {
            type: "function",
            function: {
              name: "",
              arguments: "",
            },
          };

          if (typeof toolCall.id === "string" && toolCall.id) {
            existing.id = toolCall.id;
          }

          if (typeof toolCall.type === "string" && toolCall.type) {
            existing.type = toolCall.type;
          }

          const fn = toolCall.function as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn.name === "string" && fn.name) {
              existing.function.name = fn.name;
            }
            if (typeof fn.arguments === "string") {
              existing.function.arguments += fn.arguments;
            }
          }

          toolCallsByIndex.set(index, existing);
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          finishReason = choice.finish_reason;
        }
      }

      if (chunk.usage) {
        if (typeof chunk.usage.prompt_tokens === "number") {
          promptTokens = chunk.usage.prompt_tokens;
        }
        if (typeof chunk.usage.completion_tokens === "number") {
          completionTokens = chunk.usage.completion_tokens;
        }
        if (typeof chunk.usage.total_tokens === "number") {
          totalTokens = chunk.usage.total_tokens;
        }
      }
    } catch {
      // Ignore malformed SSE lines
    }
  }

  if (!totalTokens) {
    totalTokens = promptTokens + completionTokens;
  }

  const toolCalls = Array.from(toolCallsByIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, toolCall]) => ({
      id: toolCall.id || `call_${index}`,
      type: toolCall.type || "function",
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments || "{}",
      },
    }));

  if (!finishReason) {
    finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  }

  const message: Record<string, unknown> = {
    role,
    content: content || null,
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: completionId,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
  };
}

// ============================================================
// Token Check
// ============================================================

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = CODEX_REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

// ============================================================
// Provider Implementation
// ============================================================

export const codexConfig: ProviderConfig = {
  name: "codex",
  displayName: "Codex",
  supportedModels: CODEX_MODELS,
};

export const codexProvider: Provider = {
  config: codexConfig,

  /**
   * Device Code Flow doesn't use redirect-based auth URL.
   * Use initiateCodexDeviceCodeFlow() instead.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getAuthUrl(_state: string, _codeVerifier?: string): string {
    throw new Error(
      "Codex uses Device Code Flow. Use initiateCodexDeviceCodeFlow() instead."
    );
  },

  /**
   * Exchange authorization code for tokens
   * Called after OAuth/device-code flow completes with the authorization_code
   */
  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    const body: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri || CODEX_REDIRECT_URI,
    };

    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const response = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Codex token exchange failed: ${response.status} ${error}`
      );
    }

    const tokens: CodexTokenResponse = await response.json();

    // Extract account ID from JWT
    const accountId =
      (tokens.id_token ? extractAccountIdFromJwt(tokens.id_token) : null) ||
      extractAccountIdFromJwt(tokens.access_token);
    const workspaceId =
      (tokens.id_token ? extractWorkspaceIdFromJwt(tokens.id_token) : null) ||
      extractWorkspaceIdFromJwt(tokens.access_token) ||
      accountId;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "", // Codex doesn't provide email
      accountId: accountId || undefined,
      workspaceId: workspaceId || undefined,
    };
  },

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Codex token refresh failed: ${response.status} ${error}`
      );
    }

    const tokens: CodexTokenResponse = await response.json();

    const accountId =
      (tokens.id_token ? extractAccountIdFromJwt(tokens.id_token) : null) ||
      extractAccountIdFromJwt(tokens.access_token);
    const workspaceId =
      (tokens.id_token ? extractWorkspaceIdFromJwt(tokens.id_token) : null) ||
      extractWorkspaceIdFromJwt(tokens.access_token) ||
      accountId;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "",
      accountId: accountId || undefined,
      workspaceId: workspaceId || undefined,
    };
  },

  /**
   * Get valid credentials (auto-refresh if expired)
   */
  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    const resolvedAccountId = extractAccountIdFromJwt(accessToken);
    if (resolvedAccountId && resolvedAccountId !== account.accountId) {
      try {
        await prisma.providerAccount.update({
          where: { id: account.id },
          data: { accountId: resolvedAccountId },
        });
        account.accountId = resolvedAccountId;
      } catch {
        // Ignore account ID sync failures
      }
    }

    if (isTokenExpired(account.expiresAt)) {
      console.log(`Refreshing token for Codex account ${account.id}`);

      try {
        const newTokens = await this.refreshToken(refreshTokenValue);

        // Update database immediately
        const updateData: Record<string, unknown> = {
          accessToken: encrypt(newTokens.accessToken),
          refreshToken: encrypt(newTokens.refreshToken),
          expiresAt: newTokens.expiresAt,
        };

        // Update accountId if we got a new one
        if (newTokens.accountId) {
          updateData.accountId = newTokens.accountId;
          account.accountId = newTokens.accountId;
        }

        await prisma.providerAccount.update({
          where: { id: account.id },
          data: updateData,
        });

        accessToken = newTokens.accessToken;
        console.log(
          `Token refreshed successfully for Codex account ${account.id}`
        );
      } catch (error) {
        console.error(
          `Failed to refresh token for Codex account ${account.id}:`,
          error
        );
        if (new Date() < account.expiresAt) {
          console.log("Using existing token as fallback");
        } else {
          throw error;
        }
      }
    }

    return accessToken;
  },

  /**
   * Make a request to Codex API
   * Converts Chat Completions format to Responses API, sends request,
   * then converts the response back to Chat Completions format
   */
  async makeRequest(
    accessToken: string,
    account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const modelName = body.model.includes("/")
      ? body.model.split("/").pop()!
      : body.model;

    // Codex endpoint currently requires stream=true for upstream requests.
    // For non-streaming downstream calls, we aggregate the stream response.
    const upstreamStream = true;

    // Build Responses API payload from Chat Completions format
    const payload = buildResponsesApiPayload(
      { ...body, model: modelName },
      upstreamStream
    );

    // Build headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: CODEX_ORIGINATOR,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    };

    // Add ChatGPT account ID if available
    if (account.accountId) {
      headers["ChatGPT-Account-Id"] = account.accountId;
    }

    const response = await fetch(CODEX_API_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    try {
      updateCodexQuotaFromHeaders(account.id, response.headers);
    } catch {
      // Ignore quota header parsing failures
    }

    // For streaming, convert Responses API SSE to Chat Completions SSE
    if (stream && response.ok && response.body) {
      const converter = createResponsesToChatCompletionsStream(modelName);

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

    // For non-streaming, aggregate SSE and convert to Chat Completions JSON
    if (response.ok && !stream) {
      const contentType = response.headers.get("content-type") || "";
      let completionData: Record<string, unknown>;

      if (contentType.includes("application/json")) {
        const responsesData = await response.json();
        completionData = convertResponseToCompletion(responsesData, modelName);
      } else if (response.body) {
        const converter = createResponsesToChatCompletionsStream(modelName);
        const transformedBody = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(converter)
          .pipeThrough(new TextEncoderStream());
        const sseText = await new Response(transformedBody).text();
        completionData = convertChatCompletionSseToCompletion(sseText, modelName);
      } else {
        return new Response(
          JSON.stringify({
            error: {
              message: "Codex response stream is empty",
              type: "api_error",
            },
          }),
          {
            status: 502,
            headers: new Headers({
              "Content-Type": "application/json",
            }),
          }
        );
      }

      return new Response(JSON.stringify(completionData), {
        status: 200,
        headers: new Headers({
          "Content-Type": "application/json",
        }),
      });
    }

    // Error responses pass through
    return response;
  },
};

// ============================================================
// Device Code Flow Functions
// ============================================================

/**
 * Initiate Codex Device Code Flow
 * Returns device code info including URL and user code for display
 */
export async function initiateCodexDeviceCodeFlow(): Promise<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
  codeVerifier: string;
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const response = await fetch(CODEX_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Codex device code request failed: ${response.status} ${error}`
    );
  }

  const data: CodexDeviceCodeResponse = await response.json();

  const intervalRaw =
    typeof data.interval === "string"
      ? Number.parseInt(data.interval, 10)
      : data.interval;
  const interval =
    typeof intervalRaw === "number" && Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : 5;

  const expiresInRaw =
    typeof data.expires_in === "string"
      ? Number.parseInt(data.expires_in, 10)
      : data.expires_in;
  let expiresIn =
    typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw) && expiresInRaw > 0
      ? expiresInRaw
      : undefined;

  if (!expiresIn && data.expires_at) {
    const expiresAtMs = Date.parse(data.expires_at);
    if (Number.isFinite(expiresAtMs)) {
      const secondsLeft = Math.ceil((expiresAtMs - Date.now()) / 1000);
      if (secondsLeft > 0) {
        expiresIn = secondsLeft;
      }
    }
  }

  if (!expiresIn) {
    expiresIn = 600;
  }

  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    expiresIn,
    interval,
    codeVerifier,
  };
}

/**
 * Poll for device code authorization
 * Returns authorization code when user completes auth, pending, or error
 */
export async function pollCodexDeviceCodeAuthorization(
  deviceAuthId: string,
  userCode: string,
  codeVerifier: string
): Promise<
  OAuthResult | { pending: true } | { error: string }
> {
  // Step 1: Poll for authorization code
  const pollResponse = await fetch(CODEX_DEVICE_POLL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      device_auth_id: deviceAuthId,
      user_code: userCode,
    }),
  });

  if (pollResponse.status === 200) {
    const pollData: CodexPollSuccessResponse = await pollResponse.json();

    if (!pollData.authorization_code) {
      return { pending: true };
    }

    const tokenCodeVerifier = pollData.code_verifier || codeVerifier;

    // Step 2: Exchange authorization code for tokens
    const tokenResponse = await fetch(CODEX_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: pollData.authorization_code,
        client_id: CODEX_CLIENT_ID,
        redirect_uri: CODEX_REDIRECT_URI,
        code_verifier: tokenCodeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      return { error: `Token exchange failed: ${tokenResponse.status} ${error}` };
    }

    const tokens: CodexTokenResponse = await tokenResponse.json();

    // Extract account ID from JWT
    const accountId =
      (tokens.id_token ? extractAccountIdFromJwt(tokens.id_token) : null) ||
      extractAccountIdFromJwt(tokens.access_token);
    const workspaceId =
      (tokens.id_token ? extractWorkspaceIdFromJwt(tokens.id_token) : null) ||
      extractWorkspaceIdFromJwt(tokens.access_token) ||
      accountId;

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      email: "",
      accountId: accountId || undefined,
      workspaceId: workspaceId || undefined,
    };
  }

  if (
    pollResponse.status === 400 ||
    pollResponse.status === 403 ||
    pollResponse.status === 404
  ) {
    try {
      const errorData = (await pollResponse.json()) as {
        error?: string | { message?: string; code?: string; type?: string };
        detail?: string;
        error_description?: string;
      };

      const errorCode =
        typeof errorData.error === "string"
          ? errorData.error
          : errorData.error?.code;
      const errorMessage =
        typeof errorData.error === "string"
          ? errorData.error
          : errorData.error?.message;
      const detail =
        typeof errorData.detail === "string"
          ? errorData.detail
          : "";

      if (
        errorCode === "authorization_pending" ||
        errorCode === "slow_down" ||
        errorCode === "deviceauth_authorization_unknown" ||
        detail.toLowerCase().includes("pending") ||
        errorMessage?.toLowerCase().includes("authorization is unknown")
      ) {
        return { pending: true };
      }

      if (errorCode === "expired_token") {
        return { error: "Device code expired. Please start again." };
      }

      if (errorCode === "access_denied") {
        return { error: "Authorization was denied by the user." };
      }

      // OpenAI currently returns 403/404 with "Device authorization is unknown"
      // while the user is still authorizing. Match opencode behavior.
      if (pollResponse.status === 403 || pollResponse.status === 404) {
        return { pending: true };
      }

      const errorValue = errorData.error_description
        || detail
        || errorMessage
        || errorCode
        || "Unknown error";
      return { error: errorValue };
    } catch {
      if (pollResponse.status === 403 || pollResponse.status === 404) {
        return { pending: true };
      }

      return { error: "Failed to parse authentication response" };
    }
  }

  // For other 4xx responses, treat as an error (not pending)
  // 401 etc. indicate real problems, not authorization_pending
  if (pollResponse.status >= 400 && pollResponse.status < 500) {
    const errorBody = await pollResponse.text();
    return { error: `Authentication failed (HTTP ${pollResponse.status}): ${errorBody || "Unknown error"}` };
  }

  const error = await pollResponse.text();
  return { error: `Unexpected error: ${pollResponse.status} ${error}` };
}

// Export utilities
export { generateCodeVerifier, generateCodeChallenge, extractAccountIdFromJwt };
