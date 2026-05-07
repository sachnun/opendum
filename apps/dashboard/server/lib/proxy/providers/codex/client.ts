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
import {
  CLIENT_ID,
  TOKEN_ENDPOINT,
  AUTHORIZE_ENDPOINT,
  BROWSER_REDIRECT_URI,
  SCOPE,
  API_BASE_URL,
  SUPPORTED_PARAMS,
  REFRESH_BUFFER_SECONDS,
  ORIGINATOR,
  CODEX_CHAT_USER_AGENT,
} from "./constants.js";
import { getProviderModelSet, resolveModelAlias } from "../../models.js";
import { updateCodexQuotaFromHeaders } from "./quota.js";
import {
  getChatGptCompatibleCodexModels,
  isChatGptAccountCompatibleCodexModel,
} from "./compat.js";

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

/**
 * Convert any tool call ID to a format accepted by the Codex Responses API.
 * The upstream Responses API requires IDs to begin with 'fc_'.
 * IDs with 'apc_' prefix (apply_patch tool) are natively valid.
 */
function toResponsesApiId(id: string): string {
  if (!id) return `fc_${crypto.randomUUID().replace(/-/g, "")}`;
  if (id.startsWith("fc_") || id.startsWith("fc-")) return id;
  if (id.startsWith("apc_")) return id; // apply_patch tool IDs are valid
  if (id.startsWith("call_")) return "fc_" + id.slice(5);
  return "fc_" + id;
}

/**
 * Convert an fc_-prefixed ID back to call_ format for Chat Completions responses.
 * Preserves IDs that are already in call_ format.
 */
function toChatCompletionsId(id: string): string {
  if (!id) return `call_${crypto.randomUUID().replace(/-/g, "")}`;
  if (id.startsWith("call_")) return id;
  if (id.startsWith("fc_")) return "call_" + id.slice(3);
  if (id.startsWith("fc-")) return "call_" + id.slice(3);
  return "call_" + id;
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

  if (SUPPORTED_PARAMS.has(key)) {
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

    if (SUPPORTED_PARAMS.has(key)) {
      filtered[key] = value;
    }
  }

  return filtered;
}

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

function toBooleanClaim(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
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

  return null;
}

/**
 * Extract ChatGPT account ID from JWT token claims.
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

function extractFedrampAccountFromClaims(decoded: Record<string, unknown>): boolean {
  const authClaims = asRecord(decoded["https://api.openai.com/auth"]);
  return (
    toBooleanClaim(authClaims?.chatgpt_account_is_fedramp) ||
    toBooleanClaim(decoded.chatgpt_account_is_fedramp)
  );
}

function extractFedrampAccountFromJwt(token: string): boolean {
  const decoded = parseJwtClaims(token);
  if (!decoded) {
    return false;
  }

  return extractFedrampAccountFromClaims(decoded);
}

function buildCodexError(
  message: string,
  code = "codex_stream_error",
  type = "api_error"
): Record<string, unknown> {
  return {
    error: {
      message,
      type,
      code,
    },
  };
}

function parseCodexSseError(event: Record<string, unknown>): Record<string, unknown> | null {
  const eventType = event.type;
  if (eventType !== "response.failed" && eventType !== "response.incomplete") {
    return null;
  }

  const response = asRecord(event.response) ?? event;
  const rawError = asRecord(response.error);
  if (eventType === "response.incomplete") {
    const incompleteDetails = asRecord(response.incomplete_details);
    const reason = toNonEmptyString(incompleteDetails?.reason) ?? "unknown";
    return buildCodexError(
      `Incomplete Codex response returned, reason: ${reason}`,
      "incomplete_response",
      "api_error"
    );
  }

  const code = toNonEmptyString(rawError?.code) ?? "response_failed";
  const message = toNonEmptyString(rawError?.message) ?? "Codex response failed.";
  const type = toNonEmptyString(rawError?.type) ?? "api_error";

  return buildCodexError(message, code, type);
}

function errorStatusFromCode(code: unknown): number {
  switch (code) {
    case "context_length_exceeded":
    case "invalid_prompt":
    case "incomplete_response":
      return 400;
    case "insufficient_quota":
    case "rate_limit_exceeded":
      return 429;
    case "server_is_overloaded":
    case "slow_down":
      return 503;
    default:
      return 502;
  }
}

/**
 * Convert a Chat Completions `image_url` content block to a Responses API `input_image` block.
 *
 * Chat Completions format:
 *   { type: "image_url", image_url: { url: "...", detail?: "..." } }
 *
 * Responses API format:
 *   { type: "input_image", image_url: "...", detail?: "..." }
 */
function convertImageUrlBlock(
  block: { type: string; [key: string]: unknown }
): { type: string; [key: string]: unknown } {
  const imageUrlValue = block.image_url;

  // Already a flat string – just change the type
  if (typeof imageUrlValue === "string") {
    const { image_url, ...rest } = block;
    return { ...rest, type: "input_image", image_url };
  }

  // Nested object { url: "...", detail?: "..." }
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

  // Fallback – just swap the type
  return { ...block, type: "input_image" };
}

/**
 * Convert Chat Completions content block types to Responses API types.
 * Chat Completions uses "text" while Responses API requires "input_text" or "output_text".
 * Chat Completions uses "image_url" while Responses API requires "input_image".
 */
function convertContentBlockTypes(
  content: Array<{ type: string; [key: string]: unknown }>,
  role: string
): Array<{ type: string; [key: string]: unknown }> {
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
        input.push({
          type: "message",
          role: "developer",
          content:
            typeof msg.content === "string"
              ? msg.content
              : convertContentBlockTypes(msg.content, "developer"),
        });
        break;

      case "user":
        input.push({
          type: "message",
          role: "user",
          content:
            typeof msg.content === "string"
              ? msg.content
              : convertContentBlockTypes(msg.content, "user"),
        });
        break;

      case "assistant":
        if (!msg.tool_calls?.length || msg.content) {
          input.push({
            type: "message",
            role: "assistant",
            content:
              typeof msg.content === "string"
                ? msg.content
                : convertContentBlockTypes(msg.content, "assistant"),
          });
        }
        for (const tc of msg.tool_calls ?? []) {
          if (!tc || typeof tc !== "object") {
            continue;
          }

          const toolCall = tc as Record<string, unknown>;
          const fn = toolCall.function as Record<string, unknown> | undefined;
          const name = fn?.name;
          if (typeof name !== "string" || !name.trim()) {
            continue;
          }

          const args = fn?.arguments;
          const rawId = typeof toolCall.id === "string" ? toolCall.id : "";
          const fcId = toResponsesApiId(rawId);
          input.push({
            type: "function_call",
            id: fcId,
            call_id: fcId,
            name: name.trim(),
            arguments: typeof args === "string" ? args : "{}",
          });
        }
        break;

      case "tool":
        // Tool result message
        input.push({
          type: "function_call_output",
          call_id: toResponsesApiId(msg.tool_call_id || ""),
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
              : convertContentBlockTypes(msg.content, msg.role),
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

function convertTools(
  tools?: ChatCompletionRequest["tools"]
): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;

  const converted = tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return null;
      }

      const rawTool = tool as Record<string, unknown>;
      const fn = rawTool.function as Record<string, unknown> | undefined;
      const source = fn && typeof fn === "object" ? fn : rawTool;
      const name = source.name;

      if (typeof name !== "string" || !name.trim()) {
        return null;
      }

      const description = source.description;
      const parameters = source.parameters;
      const strict = source.strict;
      const deferLoading = source.defer_loading;
      const convertedTool: Record<string, unknown> = {
        type: "function",
        name: name.trim(),
        description: typeof description === "string" ? description : "",
        parameters:
          parameters && typeof parameters === "object" && !Array.isArray(parameters)
            ? parameters
            : { type: "object", properties: {} },
      };

      if (typeof strict === "boolean") {
        convertedTool.strict = strict;
      }

      if (typeof deferLoading === "boolean") {
        convertedTool.defer_loading = deferLoading;
      }

      return convertedTool;
    })
    .filter((tool): tool is Record<string, unknown> => tool !== null);

  return converted.length > 0 ? converted : undefined;
}

function convertToolChoice(toolChoice: ChatCompletionRequest["tool_choice"]): unknown {
  if (!toolChoice || typeof toolChoice !== "object") {
    return toolChoice;
  }

  const rawToolChoice = toolChoice as Record<string, unknown>;
  if (rawToolChoice.type !== "function") {
    return toolChoice;
  }

  const fn = rawToolChoice.function as Record<string, unknown> | undefined;
  const name = fn && typeof fn === "object" ? fn.name : rawToolChoice.name;
  if (typeof name !== "string" || !name.trim()) {
    return toolChoice;
  }

  return {
    type: "function",
    name: name.trim(),
  };
}

/**
 * Normalize content block types within a message's content array.
 * Converts Chat Completions "text" type to Responses API "input_text" or "output_text".
 * Converts Chat Completions "image_url" type to Responses API "input_image".
 */
function normalizeContentBlockTypes(
  content: unknown,
  role: string
): unknown {
  if (!Array.isArray(content)) return content;
  const targetTextType = role === "assistant" ? "output_text" : "input_text";
  return content.map((block: Record<string, unknown>) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text") {
      return { ...block, type: targetTextType };
    }
    if (block.type === "image_url") {
      return convertImageUrlBlock(block as { type: string; [key: string]: unknown });
    }
    return block;
  });
}

/**
 * Normalize IDs and content block types in a Responses API input[] array.
 * This handles the _responsesInput passthrough path where input items
 * from /v1/responses are sent directly without going through convertMessagesToInput().
 */
function normalizeResponsesInputIds(
  input: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return input.map((item) => {
    const type = item.type as string | undefined;

    if (type === "function_call") {
      const id = item.id as string | undefined;
      const callId = item.call_id as string | undefined;
      const normalizedId = toResponsesApiId(id || callId || "");
      return {
        ...item,
        id: normalizedId,
        call_id: normalizedId,
      };
    }

    if (type === "function_call_output") {
      const callId = item.call_id as string | undefined;
      if (callId) {
        return {
          ...item,
          call_id: toResponsesApiId(callId),
        };
      }
    }

    // Normalize content block types for message items
    if (type === "message" && item.content) {
      const role = (item.role as string) || "user";
      const normalizedContent = normalizeContentBlockTypes(item.content, role);
      if (normalizedContent !== item.content) {
        return { ...item, content: normalizedContent };
      }
    }

    return item;
  });
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
      ? normalizeResponsesInputIds(body._responsesInput)
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

  const tools = convertTools(body.tools);
  setIfCodexParamSupported(payload, "tools", tools);

  // Codex endpoint currently rejects sampling controls
  // like temperature/top_p; omit them to avoid 400 errors.
  setIfCodexParamSupported(
    payload,
    "tool_choice",
    body.tool_choice === undefined && tools ? "auto" : convertToolChoice(body.tool_choice)
  );
  setIfCodexParamSupported(
    payload,
    "parallel_tool_calls",
    body.parallel_tool_calls
  );

  const reasoningConfig: Record<string, unknown> | undefined = body.reasoning && typeof body.reasoning === "object" ? { ...body.reasoning } : body.reasoning_effort ? { effort: body.reasoning_effort } : undefined;

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
  setIfCodexParamSupported(payload, "service_tier", body.service_tier);
  setIfCodexParamSupported(payload, "prompt_cache_key", body._sessionId);
  if (body._sessionId) {
    setIfCodexParamSupported(payload, "client_metadata", {
      session_id: body._sessionId,
    });
  }

  return filterSupportedCodexPayload(payload);
}

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
          const event = JSON.parse(jsonStr) as Record<string, unknown>;
          const eventType = event.type;
          const errorPayload = parseCodexSseError(event);
          if (errorPayload) {
            const error = asRecord(errorPayload.error);
            const chunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
              error,
            };
            controller.enqueue(`data: ${JSON.stringify(chunk)}\n\n`);
            if (!sentDone) {
              sentDone = true;
              controller.enqueue("data: [DONE]\n\n");
            }
            break;
          }

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
            case "response.reasoning_text.delta":
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
              const item = asRecord(event.item);
              if (item?.type === "function_call") {
                if (!sentRole) {
                  controller.enqueue(
                    makeChatChunk({ role: "assistant" })
                  );
                  sentRole = true;
                }
                currentFunctionCallName =
                  typeof item.name === "string" ? item.name : "";
                currentFunctionCallId = toChatCompletionsId(
                  (typeof item.call_id === "string" ? item.call_id : undefined) ||
                    (typeof item.id === "string" ? item.id : undefined) ||
                    `fc_${Date.now()}`
                );

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
            case "response.function_call_arguments.delta":
            case "response.custom_tool_call_input.delta": {
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
                asRecord(event.item)?.type === "function_call" ||
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
              const response = asRecord(event.response) ?? event;
              // Extract usage if available
              const usage = asRecord(response.usage);
              if (usage) {
                inputTokens =
                  (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) ||
                  (typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0) ||
                  0;
                outputTokens =
                  (typeof usage.output_tokens === "number" ? usage.output_tokens : 0) ||
                  (typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0) ||
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
    const handlers = {
      message: () => {
        const itemContent = item.content as Array<Record<string, unknown>>;
        if (Array.isArray(itemContent)) content += itemContent.filter((part) => part.type === "output_text").map((part) => (part.text as string) || "").join("");
      },
      reasoning: () => {
        const extracted = extractReasoningText(item);
        if (extracted) reasoningContent += reasoningContent ? `\n${extracted}` : extracted;
      },
      function_call: () => {
        toolCalls.push({ id: toChatCompletionsId((item.call_id as string) || (item.id as string) || `fc_${toolCallIndex}`), type: "function", function: { name: item.name as string, arguments: (item.arguments as string) || "{}" } });
        toolCallIndex++;
      },
    } satisfies Record<string, () => void>;
    handlers[String(item.type)]?.();
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
  let errorPayload: Record<string, unknown> | null = null;
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
        error?: Record<string, unknown>;
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

      if (chunk.error) {
        errorPayload = { error: chunk.error };
        continue;
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

  if (errorPayload) {
    return errorPayload;
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

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = REFRESH_BUFFER_SECONDS * 1000;
  return new Date().getTime() > expiresAt.getTime() - bufferMs;
}

const codexConfig: ProviderConfig = {
  name: "codex",
  displayName: "Codex",
  supportedModels: getProviderModelSet("codex"),
};

export const codexProvider: Provider = {
  config: codexConfig,

  /**
   * Generate OAuth authorization URL.
   */
  async getAuthUrl(state: string, codeVerifier?: string): Promise<string> {
    if (!codeVerifier) {
      throw new Error("Codex OAuth requires a PKCE code verifier.");
    }

    const codeChallenge = await generateCodeChallenge(codeVerifier);

    return `${AUTHORIZE_ENDPOINT}?${new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: BROWSER_REDIRECT_URI,
      scope: SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: ORIGINATOR,
    })}`;
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
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
    };

    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const response = await fetch(TOKEN_ENDPOINT, {
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

    const tokens = await response.json() as CodexTokenResponse;

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
  },

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Codex token refresh failed: ${response.status} ${error}`
      );
    }

    const tokens = await response.json() as CodexTokenResponse;

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
        await db
          .update(providerAccount)
          .set({ accountId: resolvedAccountId })
          .where(eq(providerAccount.id, account.id));
        account.accountId = resolvedAccountId;
      } catch {
        // Ignore account ID sync failures
      }
    }

    if (isTokenExpired(account.expiresAt)) {
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

        await db
          .update(providerAccount)
          .set(updateData)
          .where(eq(providerAccount.id, account.id));

        accessToken = newTokens.accessToken;
      } catch (error) {
        console.error(
          `Failed to refresh token for Codex account ${account.id}:`,
          error
        );
        if (new Date() >= account.expiresAt) {
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
    const requestedModel = body.model.includes("/")
      ? body.model.split("/").pop()!
      : body.model;
    const modelName = resolveModelAlias(requestedModel);

    if (!isChatGptAccountCompatibleCodexModel(modelName)) {
      const supportedModels = getChatGptCompatibleCodexModels();
      return new Response(
        JSON.stringify({
          error: {
            message:
              `Model "${requestedModel}" is not supported for Codex when using a ChatGPT account. ` +
              `Use one of: ${supportedModels.join(", ")}.`,
            type: "invalid_request_error",
            param: "model",
            code: "unsupported_codex_chatgpt_model",
          },
        }),
        {
          status: 400,
          headers: new Headers({
            "Content-Type": "application/json",
          }),
        }
      );
    }

    // Codex endpoint currently requires stream=true for upstream requests.
    // For non-streaming downstream calls, we aggregate the stream response.
    const upstreamStream = true;

    const payload = buildResponsesApiPayload(
      { ...body, model: modelName },
      upstreamStream
    );

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      originator: ORIGINATOR,
      "User-Agent": CODEX_CHAT_USER_AGENT,
    };

    const chatgptAccountId = extractAccountIdFromJwt(accessToken);
    if (chatgptAccountId) {
      headers["ChatGPT-Account-Id"] = chatgptAccountId;
    }

    if (extractFedrampAccountFromJwt(accessToken)) {
      headers["X-OpenAI-Fedramp"] = "true";
    }

    if (body._sessionId) {
      headers.session_id = body._sessionId;
    }

    const response = await fetch(API_BASE_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    try {
      await updateCodexQuotaFromHeaders(account.id, response.headers);
    } catch {
      // Ignore quota header parsing failures
    }

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

    if (response.ok && !stream) {
      const contentType = response.headers.get("content-type") || "";
      let completionData: Record<string, unknown>;

      if (contentType.includes("application/json")) {
        const responsesData = await response.json() as Record<string, unknown>;
        completionData = convertResponseToCompletion(responsesData, modelName);
      } else if (response.body) {
        const converter = createResponsesToChatCompletionsStream(modelName);
        const transformedBody = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(converter)
          .pipeThrough(new TextEncoderStream());
        const sseText = await new Response(transformedBody).text();
        completionData = convertChatCompletionSseToCompletion(sseText, modelName);
        const completionError = asRecord(completionData.error);
        if (completionError) {
          return new Response(JSON.stringify(completionData), {
            status: errorStatusFromCode(completionError.code),
            headers: new Headers({
              "Content-Type": "application/json",
            }),
          });
        }
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

// Export utilities
export { generateCodeVerifier, generateCodeChallenge };
