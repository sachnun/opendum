function randomID(prefix: string): string {
    return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content))
        return content == null ? "" : JSON.stringify(content);

    return content
        .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            return stringValue((part as any).text);
        })
        .join("");
}

function responsesContentToChat(content: unknown): unknown {
    if (!Array.isArray(content)) return content;

    return content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const converted = { ...part } as any;
        if (
            converted.type === "input_text" ||
            converted.type === "output_text"
        ) {
            converted.type = "text";
        } else if (converted.type === "input_image") {
            converted.type = "image_url";
            if (typeof converted.image_url === "string") {
                converted.image_url = {
                    url: converted.image_url,
                    ...(converted.detail ? { detail: converted.detail } : {}),
                };
                delete converted.detail;
            }
        }
        return converted;
    });
}

function normalizeResponsesContent(content: unknown, role: string): unknown {
    if (!Array.isArray(content)) return content;
    const textType = role === "assistant" ? "output_text" : "input_text";

    return content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const converted = { ...part } as any;
        if (converted.type === "text") converted.type = textType;
        if (converted.type === "image_url") {
            converted.type = "input_image";
            if (
                converted.image_url &&
                typeof converted.image_url === "object"
            ) {
                if (converted.image_url.detail != null) {
                    converted.detail = converted.image_url.detail;
                }
                converted.image_url = stringValue(converted.image_url.url);
            }
        }
        return converted;
    });
}

export function toResponsesAPIID(id: unknown): string {
    const value = stringValue(id);
    if (!value) return randomID("fc");
    if (
        value.startsWith("fc_") ||
        value.startsWith("fc-") ||
        value.startsWith("apc_")
    ) {
        return value;
    }
    if (value.startsWith("call_")) return `fc_${value.slice(5)}`;
    return `fc_${value}`;
}

export function toChatCallID(id: unknown): string {
    const value = stringValue(id);
    if (!value) return randomID("call");
    if (value.startsWith("call_")) return value;
    if (value.startsWith("fc_") || value.startsWith("fc-")) {
        return `call_${value.slice(3)}`;
    }
    return `call_${value}`;
}

export function messagesToResponsesInput(messages: any[]): any[] {
    const input: any[] = [];

    for (const msg of messages) {
        const role = msg.role || "user";
        const content = normalizeResponsesContent(msg.content, role);

        switch (role) {
            case "system":
            case "developer":
                input.push({ type: "message", role: "developer", content });
                break;
            case "user":
                input.push({ type: "message", role: "user", content });
                break;
            case "assistant":
                if (
                    Array.isArray(msg.tool_calls) &&
                    msg.tool_calls.length > 0
                ) {
                    if (content != null && contentToText(content) !== "") {
                        input.push({
                            type: "message",
                            role: "assistant",
                            content,
                        });
                    }
                    for (const call of msg.tool_calls) {
                        const name = stringValue(call.function?.name);
                        if (!name) continue;
                        const id = toResponsesAPIID(call.id);
                        input.push({
                            type: "function_call",
                            id,
                            call_id: id,
                            name,
                            arguments:
                                stringValue(call.function?.arguments) || "{}",
                        });
                    }
                } else {
                    input.push({ type: "message", role: "assistant", content });
                }
                break;
            case "tool":
                input.push({
                    type: "function_call_output",
                    call_id: toResponsesAPIID(msg.tool_call_id),
                    output: contentToText(msg.content),
                });
                break;
            default:
                input.push({ type: "message", role, content });
                break;
        }
    }

    return input;
}

export function responsesInputToMessages(input: any[]): any[] {
    const messages: any[] = [];
    let pendingToolCalls: any[] = [];

    const flushToolCalls = () => {
        if (pendingToolCalls.length === 0) return;
        messages.push({
            role: "assistant",
            content: "",
            tool_calls: pendingToolCalls,
        });
        pendingToolCalls = [];
    };

    for (const item of input) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "message" || !item.type) {
            flushToolCalls();
            messages.push({
                role:
                    item.role === "developer" ? "system" : item.role || "user",
                content: responsesContentToChat(item.content),
            });
        } else if (item.type === "function_call") {
            pendingToolCalls.push({
                id: toChatCallID(item.call_id || item.id),
                type: "function",
                function: {
                    name: stringValue(item.name),
                    arguments: stringValue(item.arguments) || "{}",
                },
            });
        } else if (item.type === "function_call_output") {
            flushToolCalls();
            messages.push({
                role: "tool",
                tool_call_id: toChatCallID(item.call_id || item.id),
                content: stringValue(item.output),
            });
        }
    }
    flushToolCalls();

    return messages;
}

function chatUsageToResponses(raw: any): Record<string, number> {
    const inputTokens = numberValue(raw?.prompt_tokens ?? raw?.input_tokens);
    const outputTokens = numberValue(
        raw?.completion_tokens ?? raw?.output_tokens,
    );
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens:
            numberValue(raw?.total_tokens) || inputTokens + outputTokens,
    };
}

function responseStatus(finishReason: unknown): "completed" | "incomplete" {
    return finishReason === "length" ? "incomplete" : "completed";
}

export function chatCompletionToResponsesJSON(data: any, model?: string): any {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    const message =
        choice?.message && typeof choice.message === "object"
            ? choice.message
            : {};
    const output: any[] = [];
    const reasoning = stringValue(
        message.reasoning_content ?? message.reasoning,
    );
    const content = stringValue(message.content);

    if (reasoning) {
        output.push({ type: "reasoning", text: reasoning });
    }
    if (content) {
        output.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: content }],
        });
    }
    if (Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
            const name = stringValue(toolCall?.function?.name);
            if (!name) continue;
            const id = toResponsesAPIID(toolCall.id);
            output.push({
                type: "function_call",
                id,
                call_id: id,
                name,
                arguments: stringValue(toolCall.function?.arguments) || "{}",
            });
        }
    }

    return {
        id: randomID("resp"),
        object: "response",
        created_at: numberValue(data?.created) || Math.floor(Date.now() / 1000),
        model: stringValue(data?.model) || model || "",
        output,
        status: responseStatus(choice?.finish_reason),
        usage: chatUsageToResponses(data?.usage),
    };
}

type ToolCallState = {
    id: string;
    name: string;
    arguments: string;
    outputIndex: number;
    added: boolean;
};

export function chatSSEToResponsesSSE(
    source: ReadableStream<Uint8Array>,
    model: string,
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const responseID = randomID("resp");
    const createdAt = Math.floor(Date.now() / 1000);
    const textItemID = randomID("msg");
    const reasoningItemID = randomID("rs");
    const tools = new Map<number, ToolCallState>();
    const outputOrder: Array<"reasoning" | "text" | number> = [];
    let buffer = "";
    let text = "";
    let reasoning = "";
    let textIndex: number | undefined;
    let reasoningIndex: number | undefined;
    let finishReason: unknown;
    let usage: any = {};
    let finalized = false;

    const response = (
        status: "in_progress" | "completed" | "incomplete",
        output: any[] = [],
    ) => ({
        id: responseID,
        object: "response",
        created_at: createdAt,
        model,
        output,
        status,
        usage: status === "in_progress" ? null : chatUsageToResponses(usage),
    });

    return new ReadableStream<Uint8Array>({
        start(controller) {
            const emit = (event: any) => {
                controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                );
            };

            const ensureReasoning = () => {
                if (reasoningIndex != null) return;
                reasoningIndex = outputOrder.length;
                outputOrder.push("reasoning");
                emit({
                    type: "response.output_item.added",
                    output_index: reasoningIndex,
                    item: {
                        id: reasoningItemID,
                        type: "reasoning",
                        text: "",
                        status: "in_progress",
                    },
                });
            };

            const ensureText = () => {
                if (textIndex != null) return;
                textIndex = outputOrder.length;
                outputOrder.push("text");
                emit({
                    type: "response.output_item.added",
                    output_index: textIndex,
                    item: {
                        id: textItemID,
                        type: "message",
                        role: "assistant",
                        content: [],
                        status: "in_progress",
                    },
                });
                emit({
                    type: "response.content_part.added",
                    item_id: textItemID,
                    output_index: textIndex,
                    content_index: 0,
                    part: { type: "output_text", text: "" },
                });
            };

            const ensureTool = (
                index: number,
                toolCall: any,
            ): ToolCallState => {
                let state = tools.get(index);
                const fn =
                    toolCall?.function && typeof toolCall.function === "object"
                        ? toolCall.function
                        : {};
                if (!state) {
                    state = {
                        id: toResponsesAPIID(toolCall?.id),
                        name: stringValue(fn.name),
                        arguments: "",
                        outputIndex: outputOrder.length,
                        added: false,
                    };
                    tools.set(index, state);
                    outputOrder.push(index);
                } else {
                    if (toolCall?.id) state.id = toResponsesAPIID(toolCall.id);
                    if (fn.name) state.name += stringValue(fn.name);
                }
                if (!state.added) {
                    emit({
                        type: "response.output_item.added",
                        output_index: state.outputIndex,
                        item: {
                            id: state.id,
                            call_id: state.id,
                            type: "function_call",
                            name: state.name,
                            arguments: "",
                            status: "in_progress",
                        },
                    });
                    state.added = true;
                }
                return state;
            };

            const finalize = () => {
                if (finalized) return;
                finalized = true;
                const output: any[] = [];

                for (const key of outputOrder) {
                    if (key === "reasoning") {
                        const item = {
                            id: reasoningItemID,
                            type: "reasoning",
                            text: reasoning,
                            status: "completed",
                        };
                        emit({
                            type: "response.reasoning_text.done",
                            text: reasoning,
                            item_id: reasoningItemID,
                            output_index: reasoningIndex,
                            content_index: 0,
                        });
                        emit({
                            type: "response.output_item.done",
                            output_index: reasoningIndex,
                            item,
                        });
                        output.push({ type: "reasoning", text: reasoning });
                    } else if (key === "text") {
                        const part = { type: "output_text", text };
                        const item = {
                            id: textItemID,
                            type: "message",
                            role: "assistant",
                            content: [part],
                            status: "completed",
                        };
                        emit({
                            type: "response.output_text.done",
                            text,
                            item_id: textItemID,
                            output_index: textIndex,
                            content_index: 0,
                        });
                        emit({
                            type: "response.content_part.done",
                            item_id: textItemID,
                            output_index: textIndex,
                            content_index: 0,
                            part,
                        });
                        emit({
                            type: "response.output_item.done",
                            output_index: textIndex,
                            item,
                        });
                        output.push({
                            type: "message",
                            role: "assistant",
                            content: [part],
                        });
                    } else {
                        const state = tools.get(key);
                        if (!state) continue;
                        const item = {
                            id: state.id,
                            call_id: state.id,
                            type: "function_call",
                            name: state.name,
                            arguments: state.arguments,
                            status: "completed",
                        };
                        emit({
                            type: "response.function_call_arguments.done",
                            arguments: state.arguments,
                            item_id: state.id,
                            output_index: state.outputIndex,
                        });
                        emit({
                            type: "response.output_item.done",
                            output_index: state.outputIndex,
                            item,
                        });
                        output.push({ ...item, status: undefined });
                        delete output[output.length - 1].status;
                    }
                }

                const status = responseStatus(finishReason);
                emit({
                    type: "response.completed",
                    response: response(status, output),
                });
            };

            const processData = (data: string) => {
                if (!data) return;
                if (data === "[DONE]") {
                    finalize();
                    return;
                }

                let chunk: any;
                try {
                    chunk = JSON.parse(data);
                } catch {
                    return;
                }
                if (chunk?.usage) usage = chunk.usage;
                const choice = Array.isArray(chunk?.choices)
                    ? chunk.choices[0]
                    : undefined;
                if (!choice) return;
                if (choice.usage) usage = choice.usage;
                if (choice.finish_reason != null)
                    finishReason = choice.finish_reason;
                const delta = choice.delta;
                if (!delta || typeof delta !== "object") return;

                const content = stringValue(delta.content);
                if (content) {
                    ensureText();
                    text += content;
                    emit({
                        type: "response.output_text.delta",
                        delta: content,
                        item_id: textItemID,
                        output_index: textIndex,
                        content_index: 0,
                    });
                }

                const reasoningDelta = stringValue(
                    delta.reasoning_content ?? delta.reasoning,
                );
                if (reasoningDelta) {
                    ensureReasoning();
                    reasoning += reasoningDelta;
                    emit({
                        type: "response.reasoning_text.delta",
                        delta: reasoningDelta,
                        item_id: reasoningItemID,
                        output_index: reasoningIndex,
                        content_index: 0,
                    });
                }

                if (Array.isArray(delta.tool_calls)) {
                    for (const toolCall of delta.tool_calls) {
                        const index = numberValue(toolCall?.index);
                        const state = ensureTool(index, toolCall);
                        const argumentsDelta = stringValue(
                            toolCall?.function?.arguments,
                        );
                        if (argumentsDelta) {
                            state.arguments += argumentsDelta;
                            emit({
                                type: "response.function_call_arguments.delta",
                                delta: argumentsDelta,
                                item_id: state.id,
                                output_index: state.outputIndex,
                            });
                        }
                    }
                }
            };

            const processBuffer = (flush = false) => {
                const normalized = buffer.replaceAll("\r\n", "\n");
                const blocks = normalized.split("\n\n");
                buffer = flush ? "" : blocks.pop() || "";
                for (const block of blocks) {
                    const data = block
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    processData(data);
                }
                if (flush && blocks.length === 0 && normalized.trim()) {
                    const data = normalized
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    processData(data);
                }
            };

            emit({
                type: "response.created",
                response: response("in_progress"),
            });
            emit({
                type: "response.in_progress",
                response: response("in_progress"),
            });

            void (async () => {
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        processBuffer();
                    }
                    buffer += decoder.decode();
                    processBuffer(true);
                    finalize();
                    controller.close();
                } catch (error) {
                    controller.error(error);
                }
            })();
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
}
