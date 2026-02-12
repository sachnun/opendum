import type { ProviderAccount } from "@prisma/client";
import { encrypt, decrypt } from "@/lib/encryption";
import { prisma } from "@/lib/db";
import type {
  ChatCompletionRequest,
  OAuthResult,
  Provider,
  ProviderConfig,
} from "../types";
import {
  KIRO_API_BASE_URL,
  KIRO_BROWSER_REDIRECT_URI,
  KIRO_DEFAULT_MODEL,
  KIRO_MODEL_MAP,
  KIRO_MODELS,
  KIRO_OAUTH_AUTHORIZE_ENDPOINT,
  KIRO_OAUTH_IDP,
  KIRO_OAUTH_REFRESH_ENDPOINT,
  KIRO_OAUTH_TOKEN_ENDPOINT,
  KIRO_REFRESH_BUFFER_SECONDS,
} from "./constants";

interface KiroTokenExchangeResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  profileArn?: string;
}

interface KiroRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  profileArn?: string;
}

interface KiroToolCall {
  id: string;
  name: string;
  args: string;
}

type JsonObject = Record<string, unknown>;

function isTokenExpired(expiresAt: Date): boolean {
  const bufferMs = KIRO_REFRESH_BUFFER_SECONDS * 1000;
  return Date.now() > expiresAt.getTime() - bufferMs;
}

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function normalizeModel(model: string): string {
  const rawModel = model.includes("/") ? model.split("/").pop() || model : model;
  return KIRO_MODEL_MAP[rawModel] || KIRO_MODEL_MAP[KIRO_DEFAULT_MODEL] || rawModel;
}

function contentToText(
  content: string | Array<{ type: string; [key: string]: unknown }>
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .join("");
}

function convertTools(tools: ChatCompletionRequest["tools"]): Array<JsonObject> {
  if (!tools || tools.length === 0) {
    return [];
  }

  return tools
    .filter((tool) => tool.type === "function" && tool.function?.name)
    .map((tool) => ({
      toolSpecification: {
        name: tool.function.name,
        description: tool.function.description || "",
        inputSchema: {
          json: tool.function.parameters || {
            type: "object",
            properties: {},
          },
        },
      },
    }));
}

function convertMessageToHistoryItem(
  message: ChatCompletionRequest["messages"][number],
  modelId: string
): JsonObject | null {
  if (message.role === "assistant") {
    const assistantResponseMessage: JsonObject = {
      content: contentToText(message.content),
    };

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const toolUses = message.tool_calls
        .map((call) => {
          const toolCall = call as {
            id?: string;
            function?: { name?: string; arguments?: string };
          };
          if (!toolCall.id || !toolCall.function?.name) {
            return null;
          }
          return {
            toolUseId: toolCall.id,
            name: toolCall.function.name,
            input: (() => {
              try {
                return JSON.parse(toolCall.function.arguments || "{}");
              } catch {
                return {};
              }
            })(),
          };
        })
        .filter((item): item is { toolUseId: string; name: string; input: unknown } => item !== null);

      if (toolUses.length > 0) {
        assistantResponseMessage.toolUses = toolUses;
      }
    }

    return { assistantResponseMessage };
  }

  const text = contentToText(message.content);

  if (message.role === "tool") {
    const userInputMessage: JsonObject = {
      content: text || "Tool result provided.",
      modelId,
      origin: "AI_EDITOR",
      userInputMessageContext: {
        toolResults: [
          {
            toolUseId: message.tool_call_id || crypto.randomUUID(),
            status: "success",
            content: [{ text: text || "" }],
          },
        ],
      },
    };

    return { userInputMessage };
  }

  if (message.role === "user" || message.role === "system" || message.role === "developer") {
    return {
      userInputMessage: {
        content: text || "Continue",
        modelId,
        origin: "AI_EDITOR",
      },
    };
  }

  return null;
}

function buildKiroRequest(body: ChatCompletionRequest): JsonObject {
  const modelId = normalizeModel(body.model);
  const conversationId = crypto.randomUUID();
  const tools = convertTools(body.tools);
  const messages = Array.isArray(body.messages) ? body.messages : [];

  const historyCandidates = messages.slice(0, -1);
  const history = historyCandidates
    .map((message) => convertMessageToHistoryItem(message, modelId))
    .filter((item): item is JsonObject => item !== null);

  const lastMessage = messages[messages.length - 1];
  let currentContent = "Continue";
  const currentContext: JsonObject = {};

  if (lastMessage) {
    if (lastMessage.role === "assistant") {
      const fallbackHistory = convertMessageToHistoryItem(lastMessage, modelId);
      if (fallbackHistory) {
        history.push(fallbackHistory);
      }
    } else {
      currentContent = contentToText(lastMessage.content) || "Continue";

      if (lastMessage.role === "tool") {
        currentContext.toolResults = [
          {
            toolUseId: lastMessage.tool_call_id || crypto.randomUUID(),
            status: "success",
            content: [{ text: currentContent }],
          },
        ];
      }
    }
  }

  if (tools.length > 0) {
    currentContext.tools = tools;
  }

  if (
    history.length > 0 &&
    !Object.prototype.hasOwnProperty.call(history[history.length - 1], "assistantResponseMessage")
  ) {
    history.push({ assistantResponseMessage: { content: "Continue" } });
  }

  const userInputMessage: JsonObject = {
    content: currentContent,
    modelId,
    origin: "AI_EDITOR",
  };

  if (Object.keys(currentContext).length > 0) {
    userInputMessage.userInputMessageContext = currentContext;
  }

  const request: JsonObject = {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId,
      currentMessage: {
        userInputMessage,
      },
    },
  };

  if (history.length > 0) {
    (request.conversationState as JsonObject).history = history;
  }

  return request;
}

function parseBalancedJsonEvents(
  source: string,
  state: { buffer: string }
): Array<JsonObject> {
  state.buffer += source;
  const events: Array<JsonObject> = [];
  let cursor = 0;

  while (cursor < state.buffer.length) {
    const start = state.buffer.indexOf("{", cursor);
    if (start === -1) {
      state.buffer = "";
      return events;
    }

    let braceCount = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < state.buffer.length; i++) {
      const ch = state.buffer[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (ch === "{") {
          braceCount += 1;
        } else if (ch === "}") {
          braceCount -= 1;
          if (braceCount === 0) {
            end = i;
            break;
          }
        }
      }
    }

    if (end === -1) {
      state.buffer = state.buffer.slice(start);
      return events;
    }

    const candidate = state.buffer.slice(start, end + 1);
    cursor = end + 1;

    try {
      const parsed = JSON.parse(candidate) as JsonObject;
      const isKiroEvent =
        typeof parsed.content === "string" ||
        typeof parsed.name === "string" ||
        typeof parsed.input === "string" ||
        parsed.stop === true;

      if (isKiroEvent) {
        events.push(parsed);
      }
    } catch {
      // ignore
    }
  }

  state.buffer = "";
  return events;
}

function makeChunk(
  completionId: string,
  model: string,
  delta: JsonObject,
  finishReason: string | null = null
): string {
  return `data: ${JSON.stringify({
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
  })}\n\n`;
}

function convertKiroEventsToCompletion(events: Array<JsonObject>, model: string): JsonObject {
  let content = "";
  const toolCalls: Array<JsonObject> = [];
  const toolCallsById = new Map<string, { index: number; name: string; args: string }>();
  let activeToolId: string | null = null;

  for (const event of events) {
    if (typeof event.content === "string") {
      content += event.content;
    }

    if (typeof event.name === "string" && typeof event.toolUseId === "string") {
      activeToolId = event.toolUseId;
      if (!toolCallsById.has(event.toolUseId)) {
        toolCallsById.set(event.toolUseId, {
          index: toolCallsById.size,
          name: event.name,
          args: "",
        });
      }
    }

    if (typeof event.input === "string" && activeToolId) {
      const existing = toolCallsById.get(activeToolId);
      if (existing) {
        existing.args += event.input;
      }
    }

    if (event.stop === true) {
      activeToolId = null;
    }
  }

  for (const [id, call] of toolCallsById.entries()) {
    toolCalls.push({
      id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.args || "{}",
      },
    });
  }

  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export const kiroConfig: ProviderConfig = {
  name: "kiro",
  displayName: "Kiro",
  supportedModels: KIRO_MODELS,
};

export const kiroProvider: Provider = {
  config: kiroConfig,

  getAuthUrl(state: string, codeVerifier?: string): string {
    void state;
    void codeVerifier;
    throw new Error("Kiro auth URL generation is async. Use buildKiroAuthUrl().");
  },

  async exchangeCode(
    code: string,
    redirectUri: string,
    codeVerifier?: string
  ): Promise<OAuthResult> {
    if (!codeVerifier) {
      throw new Error("Code verifier is required for Kiro token exchange");
    }

    const response = await fetch(KIRO_OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "KiroIDE",
      },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri || KIRO_BROWSER_REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kiro token exchange failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as KiroTokenExchangeResponse;
    const profileArn = data.profileArn || "";
    const accountIdentifier = profileArn || crypto.randomUUID();

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
      email: `kiro-${accountIdentifier}`,
      accountId: profileArn || undefined,
    };
  },

  async refreshToken(refreshToken: string): Promise<OAuthResult> {
    const response = await fetch(KIRO_OAUTH_REFRESH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "KiroIDE",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kiro token refresh failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as KiroRefreshResponse;
    const profileArn = data.profileArn || "";

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || refreshToken,
      expiresAt: new Date(Date.now() + (data.expiresIn || 3600) * 1000),
      email: profileArn ? `kiro-${profileArn}` : "",
      accountId: profileArn || undefined,
    };
  },

  async getValidCredentials(account: ProviderAccount): Promise<string> {
    let accessToken = decrypt(account.accessToken);
    const refreshTokenValue = decrypt(account.refreshToken);

    if (!isTokenExpired(account.expiresAt)) {
      return accessToken;
    }

    const refreshed = await this.refreshToken(refreshTokenValue);
    await prisma.providerAccount.update({
      where: { id: account.id },
      data: {
        accessToken: encrypt(refreshed.accessToken),
        refreshToken: encrypt(refreshed.refreshToken),
        expiresAt: refreshed.expiresAt,
        ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
        ...(refreshed.email ? { email: refreshed.email } : {}),
      },
    });

    accessToken = refreshed.accessToken;
    return accessToken;
  },

  async makeRequest(
    credentials: string,
    account: ProviderAccount,
    body: ChatCompletionRequest,
    stream: boolean
  ): Promise<Response> {
    const modelName = body.model.includes("/") ? body.model.split("/").pop() || body.model : body.model;
    const payload = buildKiroRequest(body);

    if (account.accountId) {
      payload.profileArn = account.accountId;
    }

    const upstreamResponse = await fetch(KIRO_API_BASE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials}`,
        "Content-Type": "application/json",
        Accept: "*/*",
        "User-Agent": "KiroIDE",
        "x-amzn-kiro-agent-mode": "vibe",
      },
      body: JSON.stringify(payload),
    });

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    if (!upstreamResponse.body) {
      return new Response(
        JSON.stringify({
          error: {
            message: "Kiro response stream is empty",
            type: "api_error",
          },
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
    const parserState = { buffer: "" };

    if (stream) {
      let sentRole = false;
      let toolCallCount = 0;
      let activeToolCall: KiroToolCall | null = null;
      const toolIndexById = new Map<string, number>();

      const transformed = upstreamResponse.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(
          new TransformStream<string, string>({
            transform(chunk, controller) {
              const events = parseBalancedJsonEvents(chunk, parserState);

              for (const event of events) {
                if (!sentRole) {
                  controller.enqueue(makeChunk(completionId, modelName, { role: "assistant", content: "" }));
                  sentRole = true;
                }

                if (typeof event.content === "string" && event.content.length > 0) {
                  controller.enqueue(makeChunk(completionId, modelName, { content: event.content }));
                }

                if (typeof event.name === "string" && typeof event.toolUseId === "string") {
                  const id = event.toolUseId;
                  const index = toolIndexById.get(id) ?? toolCallCount;
                  if (!toolIndexById.has(id)) {
                    toolIndexById.set(id, index);
                    toolCallCount += 1;
                  }

                  activeToolCall = { id, name: event.name, args: "" };

                  controller.enqueue(
                    makeChunk(completionId, modelName, {
                      tool_calls: [
                        {
                          index,
                          id,
                          type: "function",
                          function: {
                            name: event.name,
                            arguments: "",
                          },
                        },
                      ],
                    })
                  );
                }

                if (typeof event.input === "string" && activeToolCall) {
                  activeToolCall.args += event.input;
                  const index = toolIndexById.get(activeToolCall.id) ?? 0;
                  controller.enqueue(
                    makeChunk(completionId, modelName, {
                      tool_calls: [
                        {
                          index,
                          function: {
                            arguments: event.input,
                          },
                        },
                      ],
                    })
                  );
                }

                if (event.stop === true) {
                  activeToolCall = null;
                }
              }
            },
            flush(controller) {
              const events = parseBalancedJsonEvents("", parserState);
              for (const event of events) {
                if (typeof event.content === "string" && event.content.length > 0) {
                  controller.enqueue(makeChunk(completionId, modelName, { content: event.content }));
                }
              }

              controller.enqueue(
                makeChunk(
                  completionId,
                  modelName,
                  {},
                  toolCallCount > 0 ? "tool_calls" : "stop"
                )
              );
              controller.enqueue("data: [DONE]\n\n");
            },
          })
        )
        .pipeThrough(new TextEncoderStream());

      return new Response(transformed, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    const rawText = await new Response(upstreamResponse.body).text();
    const events = parseBalancedJsonEvents(rawText, { buffer: "" });
    const completion = convertKiroEventsToCompletion(events, modelName);

    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};

export async function buildKiroAuthUrl(state: string, codeVerifier: string): Promise<string> {
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    idp: KIRO_OAUTH_IDP,
    redirect_uri: KIRO_BROWSER_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
  });

  return `${KIRO_OAUTH_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}
