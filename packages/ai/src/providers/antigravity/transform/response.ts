import { randomUUID } from "node:crypto";
import { cacheSignatureSync } from "./cache.js";
import type { ModelFamily, ToolSchemaMap } from "./types.js";

type JsonObject = Record<string, any>;

function object(value: unknown): JsonObject | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined;
}

function array(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function count(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function randomId(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function unwrapGeminiResponse(value: unknown): JsonObject {
    if (Array.isArray(value)) {
        for (const item of value) {
            const response = unwrapGeminiResponse(item);
            if (Object.keys(response).length) return response;
        }
        return {};
    }
    const record = object(value) ?? {};
    return object(record.response) ?? record;
}

function normalizeArguments(
    value: unknown,
    name: string,
    schemas: ToolSchemaMap,
): unknown {
    const args = object(value);
    if (!args) return value ?? {};
    const properties = schemas[name]?.parameters ?? {};
    return Object.fromEntries(
        Object.entries(args).map(([key, raw]) => {
            const expected = object(properties[key]);
            if (
                typeof raw === "string" &&
                (expected?.type === "array" || expected?.type === "object")
            ) {
                try {
                    return [key, JSON.parse(raw)];
                } catch {
                    return [key, raw];
                }
            }
            if (
                typeof raw === "string" &&
                (raw.includes("\\n") || raw.includes("\\t")) &&
                !raw.includes('\\"') &&
                !raw.includes("\\\\")
            ) {
                try {
                    return [key, JSON.parse(`"${raw.replaceAll('"', '\\"')}"`)];
                } catch {
                    return [key, raw];
                }
            }
            return [key, raw];
        }),
    );
}

function deltas(
    response: JsonObject,
    schemas: ToolSchemaMap,
    nextToolIndex: () => number,
): JsonObject[] {
    const result: JsonObject[] = [];
    for (const rawCandidate of array(response.candidates)) {
        const content = object(object(rawCandidate)?.content);
        for (const rawPart of array(content?.parts)) {
            const part = object(rawPart);
            if (!part) continue;
            const call = object(part.functionCall);
            if (call) {
                const name = text(call.name);
                result.push({
                    tool_calls: [
                        {
                            index: nextToolIndex(),
                            id: text(call.id) || randomId("call"),
                            type: "function",
                            function: {
                                name,
                                arguments: JSON.stringify(
                                    normalizeArguments(
                                        call.args,
                                        name,
                                        schemas,
                                    ) ?? {},
                                ),
                            },
                        },
                    ],
                });
            } else if (text(part.text)) {
                result.push(
                    part.thought === true
                        ? { reasoning_content: part.text }
                        : { content: part.text },
                );
            }
        }
    }
    return result;
}

function finishReason(
    response: JsonObject,
    hasTools: boolean,
): string | undefined {
    const finish = array(response.candidates)
        .map((candidate) => text(object(candidate)?.finishReason))
        .find(Boolean);
    if (!finish) return undefined;
    if (hasTools || finish === "TOOL_CALLS") return "tool_calls";
    return finish === "MAX_TOKENS" ? "length" : "stop";
}

function usage(response: JsonObject): JsonObject | undefined {
    const metadata = object(response.usageMetadata);
    if (!metadata) return undefined;
    const result: JsonObject = {
        prompt_tokens: count(metadata.promptTokenCount),
        completion_tokens: count(metadata.candidatesTokenCount),
        total_tokens: count(metadata.totalTokenCount),
    };
    if (count(metadata.cachedContentTokenCount))
        result.prompt_tokens_details = {
            cached_tokens: count(metadata.cachedContentTokenCount),
        };
    if (count(metadata.thoughtsTokenCount))
        result.completion_tokens_details = {
            reasoning_tokens: count(metadata.thoughtsTokenCount),
        };
    return result;
}

function cacheSignatures(
    response: JsonObject,
    family: ModelFamily,
    sessionId: string,
): void {
    for (const rawCandidate of array(response.candidates)) {
        for (const rawPart of array(
            object(object(rawCandidate)?.content)?.parts,
        )) {
            const part = object(rawPart);
            if (
                part?.thought === true &&
                text(part.text) &&
                text(part.thoughtSignature)
            ) {
                cacheSignatureSync(
                    family,
                    sessionId,
                    text(part.text),
                    text(part.thoughtSignature),
                );
            }
        }
    }
}

export function geminiToOpenAICompletion(
    value: unknown,
    model: string,
    schemas: ToolSchemaMap,
    family: ModelFamily,
    sessionId: string,
): JsonObject {
    const response = unwrapGeminiResponse(value);
    cacheSignatures(response, family, sessionId);
    let toolIndex = 0;
    let content = "";
    let reasoning = "";
    const toolCalls: JsonObject[] = [];
    for (const delta of deltas(response, schemas, () => toolIndex++)) {
        content += text(delta.content);
        reasoning += text(delta.reasoning_content);
        toolCalls.push(
            ...array(delta.tool_calls)
                .map(object)
                .filter((call): call is JsonObject => !!call)
                .map(({ index: _index, ...call }) => call),
        );
    }
    const message: JsonObject = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
        id: randomId("chatcmpl"),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message,
                finish_reason:
                    finishReason(response, toolCalls.length > 0) ??
                    (toolCalls.length ? "tool_calls" : "stop"),
            },
        ],
        usage: usage(response) ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}

function parseSSEEvents(
    buffer: string,
    flush = false,
): { events: string[]; rest: string } {
    const normalized = buffer.replaceAll("\r\n", "\n");
    const blocks = normalized.split("\n\n");
    const trailing = blocks.pop() ?? "";
    if (flush && trailing) blocks.push(trailing);
    const events = blocks
        .map((block) =>
            block
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n"),
        )
        .filter(Boolean);
    return { events, rest: flush ? "" : trailing };
}

export async function geminiSSEToOpenAICompletion(
    response: Response,
    model: string,
    schemas: ToolSchemaMap,
    family: ModelFamily,
    sessionId: string,
): Promise<Response> {
    const source = await response.text();
    let content = "";
    let reasoning = "";
    let latestUsage: JsonObject | undefined;
    let finish = "stop";
    let toolIndex = 0;
    const toolCalls: JsonObject[] = [];
    for (const event of parseSSEEvents(source, true).events) {
        if (!event || event === "[DONE]") continue;
        try {
            const gemini = unwrapGeminiResponse(JSON.parse(event));
            cacheSignatures(gemini, family, sessionId);
            for (const delta of deltas(gemini, schemas, () => toolIndex++)) {
                content += text(delta.content);
                reasoning += text(delta.reasoning_content);
                toolCalls.push(
                    ...array(delta.tool_calls)
                        .map(object)
                        .filter((call): call is JsonObject => !!call)
                        .map(({ index: _index, ...call }) => call),
                );
            }
            latestUsage = usage(gemini) ?? latestUsage;
            finish = finishReason(gemini, toolCalls.length > 0) ?? finish;
        } catch {
            /* Ignore malformed upstream events, matching the Go scanner. */
        }
    }
    const message: JsonObject = { role: "assistant", content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) {
        message.tool_calls = toolCalls;
        finish = "tool_calls";
    }
    return Response.json({
        id: randomId("chatcmpl"),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: latestUsage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    });
}

export function transformGeminiSSE(
    response: Response,
    model: string,
    schemas: ToolSchemaMap,
    family: ModelFamily,
    sessionId: string,
): Response {
    if (!response.body) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const completionId = randomId("chatcmpl");
    let buffer = "";
    let sentRole = false;
    let sentFinish = false;
    let hasTools = false;
    let toolIndex = 0;
    let latestUsage: JsonObject | undefined;
    const encodeChunk = (
        delta: JsonObject,
        finish: string | null,
        chunkUsage?: JsonObject,
    ) =>
        encoder.encode(
            `data: ${JSON.stringify({
                id: completionId,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta, finish_reason: finish }],
                ...(chunkUsage ? { usage: chunkUsage } : {}),
            })}\n\n`,
        );
    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                buffer += decoder.decode(value, { stream: !done });
                const parsed = parseSSEEvents(buffer, done);
                buffer = parsed.rest;
                for (const event of parsed.events) {
                    if (!event || event === "[DONE]") continue;
                    try {
                        const gemini = unwrapGeminiResponse(JSON.parse(event));
                        cacheSignatures(gemini, family, sessionId);
                        latestUsage = usage(gemini) ?? latestUsage;
                        const eventDeltas = deltas(
                            gemini,
                            schemas,
                            () => toolIndex++,
                        );
                        if (eventDeltas.length && !sentRole) {
                            controller.enqueue(
                                encodeChunk(
                                    { role: "assistant", content: "" },
                                    null,
                                ),
                            );
                            sentRole = true;
                        }
                        for (const delta of eventDeltas) {
                            if (delta.tool_calls) hasTools = true;
                            controller.enqueue(encodeChunk(delta, null));
                        }
                        const finish = finishReason(gemini, hasTools);
                        if (finish) {
                            controller.enqueue(encodeChunk({}, finish));
                            sentFinish = true;
                        }
                    } catch {
                        /* Ignore malformed upstream events. */
                    }
                }
                if (done) {
                    if (latestUsage)
                        controller.enqueue(encodeChunk({}, null, latestUsage));
                    if (!sentFinish)
                        controller.enqueue(
                            encodeChunk({}, hasTools ? "tool_calls" : "stop"),
                        );
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    controller.close();
                }
            } catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return new Response(stream, {
        status: 200,
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
}
