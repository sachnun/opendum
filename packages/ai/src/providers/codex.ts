import type {
    Provider,
    ProviderRequestOptions,
    RefreshedCredentials,
} from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";
import {
    messagesToResponsesInput,
    toChatCallID,
    toResponsesAPIID,
} from "../protocol/responses/transform.js";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_ORIGINATOR = "opencode";
const CODEX_REFRESH_BUFFER_SECONDS = 300;
const DEFAULT_INSTRUCTIONS = "You are Codex, an expert coding assistant.";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";

type JsonRecord = Record<string, any>;

function isRecord(value: unknown): value is JsonRecord {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function randomID(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function parseJwtPayload(token: string): JsonRecord | null {
    try {
        const parts = token.split(".");
        if (parts.length < 2) return null;
        const claims = JSON.parse(
            Buffer.from(parts[1]!, "base64url").toString("utf-8"),
        );
        return isRecord(claims) ? claims : null;
    } catch {
        return null;
    }
}

function claimSources(claims: JsonRecord | null): JsonRecord[] {
    if (!claims) return [];
    const auth = claims[JWT_AUTH_CLAIM];
    return isRecord(auth) ? [auth, claims] : [claims];
}

function firstStringClaim(claims: JsonRecord, key: string): string {
    return stringValue(claims[key]).trim();
}

function extractOrganizationID(claims: JsonRecord): string {
    const organizations = Array.isArray(claims.organizations)
        ? claims.organizations
        : [];
    for (const preferDefault of [true, false]) {
        for (const organization of organizations) {
            if (!isRecord(organization)) continue;
            const isDefault =
                organization.is_default === true ||
                organization.default === true;
            if (preferDefault && !isDefault) continue;
            const id = firstStringClaim(organization, "id");
            if (id) return id;
        }
    }
    return "";
}

function extractAccountIDFromJWT(token: string): string {
    const claims = parseJwtPayload(token);
    for (const source of claimSources(claims)) {
        const accountID = firstStringClaim(source, "chatgpt_account_id");
        if (accountID) return accountID;
    }
    for (const source of claimSources(claims)) {
        for (const key of [
            "chatgpt_workspace_id",
            "workspace_id",
            "organization_id",
        ]) {
            const workspaceID = firstStringClaim(source, key);
            if (workspaceID) return workspaceID;
        }
        const organizationID = extractOrganizationID(source);
        if (organizationID) return organizationID;
    }
    return "";
}

function extractTierFromJWT(token: string): string {
    const claims = parseJwtPayload(token);
    for (const source of claimSources(claims)) {
        const tier = firstStringClaim(source, "chatgpt_plan_type");
        if (tier) return tier.toLowerCase();
    }
    return "";
}

function contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) {
        return content == null ? "" : JSON.stringify(content);
    }
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            return isRecord(part) ? stringValue(part.text) : "";
        })
        .join("");
}

function extractInstructions(messages: any[]): string {
    const instructions: string[] = [];
    for (const message of messages) {
        if (!isRecord(message)) continue;
        if (message.role !== "system" && message.role !== "developer") continue;
        const text = contentToText(message.content).trim();
        if (text) instructions.push(text);
    }
    return instructions.join("\n\n");
}

function normalizeResponsesContent(content: unknown, role: string): unknown {
    if (!Array.isArray(content)) return content;
    const textType = role === "assistant" ? "output_text" : "input_text";
    return content.map((part) => {
        if (!isRecord(part)) return part;
        const converted = { ...part };
        if (converted.type === "text") converted.type = textType;
        if (converted.type === "image_url") {
            converted.type = "input_image";
            if (isRecord(converted.image_url)) {
                if (converted.image_url.detail != null) {
                    converted.detail = converted.image_url.detail;
                }
                converted.image_url = stringValue(converted.image_url.url);
            }
        }
        return converted;
    });
}

function normalizeResponsesInput(input: any[]): any[] {
    return input.map((rawItem) => {
        if (!isRecord(rawItem)) return rawItem;
        const item = { ...rawItem };
        if (item.type === "function_call") {
            const id = toResponsesAPIID(item.id || item.call_id);
            item.id = id;
            item.call_id = id;
        } else if (item.type === "function_call_output") {
            item.call_id = toResponsesAPIID(item.call_id);
        } else if (item.type === "message") {
            item.content = normalizeResponsesContent(
                item.content,
                stringValue(item.role) || "user",
            );
        }
        return item;
    });
}

function convertToolsForResponses(raw: unknown): any[] {
    if (!Array.isArray(raw)) return [];
    const converted: any[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        const functionDefinition = isRecord(item.function)
            ? item.function
            : item;
        const name = stringValue(functionDefinition.name);
        if (!name) continue;
        const tool: JsonRecord = {
            type: "function",
            name,
            description: stringValue(functionDefinition.description),
            parameters: isRecord(functionDefinition.parameters)
                ? functionDefinition.parameters
                : { type: "object", properties: {} },
        };
        if (typeof functionDefinition.strict === "boolean") {
            tool.strict = functionDefinition.strict;
        }
        converted.push(tool);
    }
    return converted;
}

function normalizeToolChoice(value: unknown): unknown {
    if (!isRecord(value) || value.type !== "function") return value;
    const name = isRecord(value.function)
        ? stringValue(value.function.name)
        : stringValue(value.name);
    return name ? { type: "function", name } : value;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter(
              (item): item is string => typeof item === "string" && !!item,
          )
        : [];
}

function sessionID(body: JsonRecord): string {
    for (const key of [
        "_sessionId",
        "prompt_cache_key",
        "session_id",
        "sessionId",
        "conversation_id",
    ]) {
        const value = stringValue(body[key]).trim();
        if (value) return value;
    }
    return "";
}

function responseHeaders(upstream: Headers, contentType: string): Headers {
    const headers = new Headers(upstream);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", contentType);
    return headers;
}

function errorResponse(status: number, error: JsonRecord): Response {
    return new Response(JSON.stringify({ error }), {
        status,
        headers: { "content-type": "application/json" },
    });
}

function responseUsageToChatUsage(raw: unknown): JsonRecord {
    const usage = isRecord(raw) ? raw : {};
    const input = numberValue(usage.input_tokens ?? usage.prompt_tokens);
    const output = numberValue(usage.output_tokens ?? usage.completion_tokens);
    return {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: numberValue(usage.total_tokens) || input + output,
    };
}

function extractReasoning(item: JsonRecord): string {
    const chunks: string[] = [];
    const text = stringValue(item.text);
    if (text) chunks.push(text);
    if (Array.isArray(item.summary)) {
        for (const summary of item.summary) {
            const summaryText =
                typeof summary === "string"
                    ? summary
                    : isRecord(summary)
                      ? stringValue(summary.text)
                      : "";
            if (summaryText) chunks.push(summaryText);
        }
    }
    return chunks.join("\n");
}

function responsesJSONToChatCompletion(
    data: JsonRecord,
    model: string,
): JsonRecord {
    let content = "";
    let reasoning = "";
    const toolCalls: any[] = [];
    for (const rawItem of Array.isArray(data.output) ? data.output : []) {
        if (!isRecord(rawItem)) continue;
        if (rawItem.type === "message") {
            for (const part of Array.isArray(rawItem.content)
                ? rawItem.content
                : []) {
                if (isRecord(part) && part.type === "output_text") {
                    content += stringValue(part.text);
                }
            }
        } else if (rawItem.type === "reasoning") {
            reasoning += extractReasoning(rawItem);
        } else if (rawItem.type === "function_call") {
            toolCalls.push({
                id: toChatCallID(rawItem.call_id || rawItem.id),
                type: "function",
                function: {
                    name: stringValue(rawItem.name),
                    arguments: stringValue(rawItem.arguments) || "{}",
                },
            });
        }
    }

    const message: JsonRecord = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    const finishReason =
        toolCalls.length > 0
            ? "tool_calls"
            : data.status === "incomplete"
              ? "length"
              : "stop";
    return {
        id: randomID("chatcmpl"),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: responseUsageToChatUsage(data.usage),
    };
}

async function consumeResponsesSSE(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onEvent: (event: JsonRecord) => void,
): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";

    const processBlock = (block: string) => {
        const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
        if (!data || data === "[DONE]") return;
        try {
            const event = JSON.parse(data);
            if (isRecord(event)) onEvent(event);
        } catch {
            // Ignore malformed upstream SSE events, matching the proxy's other adapters.
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replaceAll("\r\n", "\n");
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) processBlock(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processBlock(buffer.replaceAll("\r\n", "\n"));
}

function responsesSSEToChatSSE(
    source: ReadableStream<Uint8Array>,
    model: string,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const completionID = randomID("chatcmpl");
    const created = Math.floor(Date.now() / 1000);
    const toolIndexes = new Map<string, number>();
    const completedTools = new Set<string>();
    let nextToolIndex = 0;
    let sentRole = false;
    let sentCompletion = false;
    const reader = source.getReader();

    return new ReadableStream<Uint8Array>({
        start(controller) {
            const emit = (
                delta: JsonRecord,
                finishReason: string | null,
                usage?: JsonRecord,
            ) => {
                const chunk: JsonRecord = {
                    id: completionID,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta, finish_reason: finishReason }],
                };
                if (usage) chunk.usage = usage;
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                );
            };
            const ensureRole = (withContent = true) => {
                if (sentRole) return;
                emit(
                    withContent
                        ? { role: "assistant", content: "" }
                        : { role: "assistant" },
                    null,
                );
                sentRole = true;
            };
            const toolKey = (event: JsonRecord, item?: JsonRecord) =>
                stringValue(event.item_id) ||
                stringValue(item?.call_id) ||
                stringValue(item?.id);

            void consumeResponsesSSE(reader, (event) => {
                const type = stringValue(event.type);
                if (type === "response.output_text.delta") {
                    ensureRole();
                    const delta = stringValue(event.delta);
                    if (delta) emit({ content: delta }, null);
                    return;
                }
                if (
                    type === "response.reasoning.delta" ||
                    type === "response.reasoning_text.delta" ||
                    type === "response.reasoning_summary_text.delta"
                ) {
                    ensureRole();
                    const delta = stringValue(event.delta);
                    if (delta) emit({ reasoning_content: delta }, null);
                    return;
                }
                if (
                    type === "response.output_item.added" &&
                    isRecord(event.item)
                ) {
                    const item = event.item;
                    if (item.type !== "function_call") return;
                    ensureRole(false);
                    const key = toolKey(event, item) || randomID("fc");
                    const index = nextToolIndex++;
                    toolIndexes.set(key, index);
                    emit(
                        {
                            tool_calls: [
                                {
                                    index,
                                    id: toChatCallID(item.call_id || item.id),
                                    type: "function",
                                    function: {
                                        name: stringValue(item.name),
                                        arguments: "",
                                    },
                                },
                            ],
                        },
                        null,
                    );
                    return;
                }
                if (
                    type === "response.function_call_arguments.delta" ||
                    type === "response.custom_tool_call_input.delta"
                ) {
                    const key = toolKey(event);
                    const index =
                        toolIndexes.get(key) ?? Math.max(0, nextToolIndex - 1);
                    const delta = stringValue(event.delta);
                    if (delta) {
                        emit(
                            {
                                tool_calls: [
                                    { index, function: { arguments: delta } },
                                ],
                            },
                            null,
                        );
                    }
                    return;
                }
                if (
                    type === "response.function_call_arguments.done" ||
                    type === "response.output_item.done"
                ) {
                    const item = isRecord(event.item) ? event.item : undefined;
                    if (
                        type === "response.function_call_arguments.done" ||
                        item?.type === "function_call"
                    ) {
                        const key = toolKey(event, item);
                        if (key) completedTools.add(key);
                    }
                    return;
                }
                if (type === "response.completed" || type === "response.done") {
                    const response = isRecord(event.response)
                        ? event.response
                        : event;
                    const hasTools =
                        toolIndexes.size > 0 || completedTools.size > 0;
                    const finishReason = hasTools
                        ? "tool_calls"
                        : response.status === "incomplete"
                          ? "length"
                          : "stop";
                    emit(
                        {},
                        finishReason,
                        responseUsageToChatUsage(response.usage),
                    );
                    sentCompletion = true;
                }
            })
                .then(() => {
                    if (!sentCompletion) {
                        emit({}, toolIndexes.size > 0 ? "tool_calls" : "stop");
                    }
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                })
                .catch((error) => controller.error(error));
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}

async function responsesStreamToCompletion(
    source: ReadableStream<Uint8Array>,
    model: string,
): Promise<JsonRecord> {
    let text = "";
    let reasoning = "";
    const finalResponse: { value?: JsonRecord } = {};
    const tools = new Map<string, JsonRecord>();
    let currentToolKey = "";

    await consumeResponsesSSE(source.getReader(), (event) => {
        const type = stringValue(event.type);
        if (type === "response.output_text.delta") {
            text += stringValue(event.delta);
        } else if (
            type === "response.reasoning.delta" ||
            type === "response.reasoning_text.delta" ||
            type === "response.reasoning_summary_text.delta"
        ) {
            reasoning += stringValue(event.delta);
        } else if (
            type === "response.output_item.added" &&
            isRecord(event.item)
        ) {
            const item = event.item;
            if (item.type === "function_call") {
                currentToolKey =
                    stringValue(item.call_id || item.id) || randomID("fc");
                tools.set(currentToolKey, {
                    type: "function_call",
                    id: item.id || currentToolKey,
                    call_id: item.call_id || currentToolKey,
                    name: stringValue(item.name),
                    arguments: "",
                });
            }
        } else if (
            type === "response.function_call_arguments.delta" ||
            type === "response.custom_tool_call_input.delta"
        ) {
            const key = stringValue(event.item_id) || currentToolKey;
            const tool = tools.get(key);
            if (tool) tool.arguments += stringValue(event.delta);
        } else if (type === "response.completed" || type === "response.done") {
            finalResponse.value = isRecord(event.response)
                ? event.response
                : event;
        }
    });

    if (finalResponse.value && Array.isArray(finalResponse.value.output)) {
        return responsesJSONToChatCompletion(finalResponse.value, model);
    }
    const output: any[] = [];
    if (reasoning) output.push({ type: "reasoning", text: reasoning });
    if (text) {
        output.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
        });
    }
    output.push(...tools.values());
    return responsesJSONToChatCompletion(
        {
            output,
            status: finalResponse.value?.status || "completed",
            usage: finalResponse.value?.usage,
        },
        model,
    );
}

export class CodexProvider implements Provider {
    public name = "codex";

    constructor(private registry: ModelRegistry) {}

    getRefreshBuffer(): number {
        return CODEX_REFRESH_BUFFER_SECONDS;
    }

    async refreshCredentials(
        refreshToken: string,
        _account: ProviderAccount,
    ): Promise<RefreshedCredentials> {
        const form = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken.trim(),
            client_id: CODEX_CLIENT_ID,
        });

        const res = await fetch(CODEX_TOKEN_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Accept: "application/json",
            },
            body: form.toString(),
        });

        if (!res.ok) {
            const text = await res.text();
            throw new Error(
                `codex token refresh failed: ${res.status} ${text}`,
            );
        }

        const data: any = await res.json();
        if (!stringValue(data.access_token)) {
            throw new Error("codex token refresh returned empty access token");
        }
        const accountId =
            extractAccountIDFromJWT(data.access_token) ||
            extractAccountIDFromJWT(data.id_token);
        const tier =
            extractTierFromJWT(data.id_token) ||
            extractTierFromJWT(data.access_token);

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
            accountId: accountId || undefined,
            tier: tier || undefined,
        };
    }

    async makeRequest(options: ProviderRequestOptions): Promise<Response> {
        const { account, credentials, body, stream, signal } = options;
        const rawModel = stringValue(body.model).split("/").pop()?.trim() || "";
        const upstreamModel = this.registry.upstreamModelName(
            rawModel,
            "codex",
        );
        const modelMap = this.registry.getProviderModelMap("codex");
        const normalizedModel = upstreamModel.toLowerCase();
        const isAllowed = Object.entries(modelMap).some(
            ([canonical, upstream]) =>
                canonical.toLowerCase() === normalizedModel ||
                upstream.toLowerCase() === normalizedModel,
        );
        if (!isAllowed) {
            const supported = Array.from(
                new Set(
                    Object.entries(modelMap).flatMap(
                        ([canonical, upstream]) => [canonical, upstream],
                    ),
                ),
            )
                .filter(Boolean)
                .sort();
            return errorResponse(400, {
                message: `Model "${upstreamModel}" is not supported for Codex when using a ChatGPT account. Use one of: ${supported.join(", ")}.`,
                type: "invalid_request_error",
                param: "model",
                code: "unsupported_codex_chatgpt_model",
            });
        }

        const messages = Array.isArray(body.messages) ? body.messages : [];
        const tools = convertToolsForResponses(body.tools);
        const explicitInstructions = stringValue(body.instructions);
        const payload: JsonRecord = {
            model: upstreamModel,
            store: false,
            stream: true,
            instructions:
                explicitInstructions ||
                extractInstructions(messages) ||
                DEFAULT_INSTRUCTIONS,
            input:
                Array.isArray(body._responsesInput) &&
                body._responsesInput.length > 0
                    ? normalizeResponsesInput(body._responsesInput)
                    : messagesToResponsesInput(messages),
        };

        if (tools.length > 0) {
            payload.tools = tools;
            if (body.tool_choice == null) payload.tool_choice = "auto";
        }
        if (body.tool_choice != null) {
            payload.tool_choice = normalizeToolChoice(body.tool_choice);
        }
        if (body.parallel_tool_calls != null) {
            payload.parallel_tool_calls = body.parallel_tool_calls;
        }
        if (isRecord(body.reasoning)) {
            payload.reasoning = { ...body.reasoning };
        } else if (stringValue(body.reasoning_effort)) {
            payload.reasoning = { effort: body.reasoning_effort };
        }
        if (
            isRecord(payload.reasoning) &&
            body._includeReasoning === true &&
            payload.reasoning.summary == null
        ) {
            payload.reasoning.summary = "auto";
        }
        const include = stringArray(body.include);
        if (body._includeReasoning === true || tools.length > 0) {
            include.push("reasoning.encrypted_content");
        }
        if (include.length > 0) payload.include = Array.from(new Set(include));
        for (const key of ["previous_response_id", "service_tier"] as const) {
            if (body[key] != null) payload[key] = body[key];
        }

        const requestSessionID = sessionID(body);
        if (requestSessionID) {
            payload.prompt_cache_key = requestSessionID;
            payload.client_metadata = { session_id: requestSessionID };
        }

        const accessToken = credentials?.trim() || "";
        const accountId =
            account.accountId?.trim() || extractAccountIDFromJWT(accessToken);
        const headers: Record<string, string> = {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            originator: CODEX_ORIGINATOR,
            "User-Agent": `opencode/1.14.28 (${process.platform}; ${process.arch})`,
        };
        if (accountId) headers["chatgpt-account-id"] = accountId;
        if (requestSessionID) headers.session_id = requestSessionID;

        const upstream = await fetch(CODEX_API_BASE_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal,
        });
        if (!upstream.ok || !upstream.body) return upstream;

        if (stream) {
            return new Response(
                responsesSSEToChatSSE(upstream.body, upstreamModel),
                {
                    status: upstream.status,
                    statusText: upstream.statusText,
                    headers: responseHeaders(
                        upstream.headers,
                        "text/event-stream",
                    ),
                },
            );
        }

        const completion = await responsesStreamToCompletion(
            upstream.body,
            upstreamModel,
        );
        return new Response(JSON.stringify(completion), {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders(upstream.headers, "application/json"),
        });
    }
}

export default CodexProvider;
