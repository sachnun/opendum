import type { Provider, ProviderRequestOptions } from "../base.js";
import type { ModelRegistry } from "../../registry/registry.js";
import {
    messagesToResponsesInput,
    toChatCallID,
    toResponsesAPIID,
} from "../../protocol/responses/transform.js";
import {
    OPENCODE_CHAT_COMPLETIONS_ENDPOINT,
    OPENCODE_RESPONSES_ENDPOINT,
    OPENCODE_PUBLIC_API_KEY,
    OPENCODE_CLIENT,
    OPENCODE_USER_AGENT,
    SUPPORTED_OPENCODE_PARAMS,
} from "./constants.js";

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

function normalizeResponsesContent(content: unknown, role: string): unknown {
    if (!Array.isArray(content)) return content;
    const textType = role === "assistant" ? "output_text" : "input_text";

    return content.map((rawPart) => {
        if (!isRecord(rawPart)) return rawPart;
        const part = { ...rawPart };
        if (part.type === "text") part.type = textType;
        if (part.type === "image_url") {
            part.type = "input_image";
            if (isRecord(part.image_url)) {
                if (part.image_url.detail != null)
                    part.detail = part.image_url.detail;
                part.image_url = stringValue(part.image_url.url);
            }
        }
        return part;
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

function convertToolsForResponses(raw: unknown): JsonRecord[] {
    if (!Array.isArray(raw)) return [];
    const tools: JsonRecord[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        const definition = isRecord(item.function) ? item.function : item;
        const name = stringValue(definition.name);
        if (!name) continue;
        const tool: JsonRecord = {
            type: "function",
            name,
            description: stringValue(definition.description),
            parameters: isRecord(definition.parameters)
                ? definition.parameters
                : { type: "object", properties: {} },
        };
        if (typeof definition.strict === "boolean")
            tool.strict = definition.strict;
        tools.push(tool);
    }
    return tools;
}

function normalizeToolChoice(value: unknown): unknown {
    if (!isRecord(value) || value.type !== "function") return value;
    const name = isRecord(value.function)
        ? stringValue(value.function.name)
        : stringValue(value.name);
    return name ? { type: "function", name } : value;
}

function buildResponsesPayload(
    body: JsonRecord,
    model: string,
    stream: boolean,
): JsonRecord {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const payload: JsonRecord = {
        model,
        stream,
        input: Array.isArray(body._responsesInput)
            ? normalizeResponsesInput(body._responsesInput)
            : messagesToResponsesInput(messages),
    };

    if (stringValue(body.instructions))
        payload.instructions = body.instructions;
    if (body.temperature != null) payload.temperature = body.temperature;
    if (body.top_p != null) payload.top_p = body.top_p;
    if (body.max_tokens != null) {
        payload.max_output_tokens = body.max_tokens;
    } else if (body.max_completion_tokens != null) {
        payload.max_output_tokens = body.max_completion_tokens;
    }

    const tools = convertToolsForResponses(body.tools);
    if (tools.length > 0) payload.tools = tools;
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

    for (const key of [
        "include",
        "previous_response_id",
        "prompt_cache_key",
        "service_tier",
        "store",
        "text",
        "truncation",
        "user",
    ]) {
        if (body[key] != null) payload[key] = body[key];
    }
    return payload;
}

function responseHeaders(upstream: Headers, contentType: string): Headers {
    const headers = new Headers(upstream);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", contentType);
    return headers;
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
    const toolCalls: JsonRecord[] = [];

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
            // Ignore malformed upstream events and continue adapting the stream.
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
    const reader = source.getReader();
    const encoder = new TextEncoder();
    const completionID = randomID("chatcmpl");
    const created = Math.floor(Date.now() / 1000);
    const toolIndexes = new Map<string, number>();
    let nextToolIndex = 0;
    let sentRole = false;
    let sentCompletion = false;

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
                if (type === "response.completed" || type === "response.done") {
                    const response = isRecord(event.response)
                        ? event.response
                        : event;
                    const finishReason =
                        toolIndexes.size > 0
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

export class OpencodeProvider implements Provider {
    public name = "opencode";

    constructor(private registry: ModelRegistry) {}

    isAuthless(): boolean {
        return true;
    }

    async makeRequest(options: ProviderRequestOptions): Promise<Response> {
        const { body, stream, signal } = options;
        const rawModel = String(body.model || "");
        const model = rawModel.startsWith("opencode/")
            ? rawModel.slice("opencode/".length)
            : rawModel;
        const upstreamModel = this.registry.upstreamModelName(
            model,
            "opencode",
        );
        const isResponses = this.registry.providerConfigBool(
            model,
            "opencode",
            "responses_api",
        );

        const payload: JsonRecord = isResponses
            ? buildResponsesPayload(body, upstreamModel, stream)
            : {};
        if (!isResponses) {
            for (const [key, value] of Object.entries(body)) {
                if (
                    SUPPORTED_OPENCODE_PARAMS.has(key) &&
                    value !== undefined &&
                    value !== null
                ) {
                    payload[key] = value;
                }
            }
            payload.model = upstreamModel;
            payload.stream = stream;
        }

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: stream ? "text/event-stream" : "application/json",
            Authorization: `Bearer ${OPENCODE_PUBLIC_API_KEY}`,
            "User-Agent": OPENCODE_USER_AGENT,
            "X-Opencode-Client": OPENCODE_CLIENT,
            "X-Opencode-Project": String(body._projectId || "global"),
            "X-Opencode-Session": String(
                body._sessionId || `ses_${Math.random().toString(36).slice(2)}`,
            ),
            "X-Opencode-Request": String(
                body._requestId || `msg_${Math.random().toString(36).slice(2)}`,
            ),
        };

        const endpoint = isResponses
            ? OPENCODE_RESPONSES_ENDPOINT
            : OPENCODE_CHAT_COMPLETIONS_ENDPOINT;
        const upstream = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal,
        });

        if (!isResponses || !upstream.ok || !upstream.body) return upstream;
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

        const completion = responsesJSONToChatCompletion(
            (await upstream.json()) as JsonRecord,
            upstreamModel,
        );
        return new Response(JSON.stringify(completion), {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders(upstream.headers, "application/json"),
        });
    }
}

export default OpencodeProvider;
