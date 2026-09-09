export interface PerchStreamCallbacks {
    onChunk(chunk: Record<string, unknown>): void;
    onDone(): void;
}

interface PerchToolCall {
    id?: unknown;
    name?: unknown;
    rawArgumentsText?: unknown;
    arguments?: unknown;
}

interface PerchEvent {
    type?: unknown;
    text?: unknown;
    toolCalls?: unknown;
    tool_calls?: unknown;
    ok?: unknown;
    error?: unknown;
    usage?: unknown;
}

interface ChatUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export class PerchUpstreamError extends Error {
    readonly quota: boolean;

    constructor(message: string) {
        super(message);
        this.name = "PerchUpstreamError";
        this.quota = isQuotaError(message);
    }
}

function randomCompletionId(): string {
    const suffix =
        globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
        Math.random().toString(36).slice(2);
    return `chatcmpl_${suffix}`;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function eventToolCalls(event: PerchEvent): PerchToolCall[] {
    const calls = Array.isArray(event.toolCalls)
        ? event.toolCalls
        : event.tool_calls;
    return Array.isArray(calls)
        ? calls.filter(
              (call): call is PerchToolCall =>
                  Boolean(call) && typeof call === "object",
          )
        : [];
}

function sealedArguments(call: PerchToolCall): string {
    if (typeof call.arguments === "string") return call.arguments;
    if (call.arguments === undefined || call.arguments === null) return "";
    try {
        return JSON.stringify(call.arguments);
    } catch {
        return "";
    }
}

function errorMessage(event: PerchEvent): string {
    if (typeof event.error === "string") return event.error;
    if (event.error === undefined || event.error === null) return "";
    try {
        return JSON.stringify(event.error);
    } catch {
        return String(event.error);
    }
}

function isQuotaError(message: string): boolean {
    const lower = message.toLowerCase();
    return ["allowance", "quota", "limit", "usage", "billing", "credit"].some(
        (marker) => lower.includes(marker),
    );
}

function usageToChatUsage(raw: unknown): ChatUsage | null {
    if (!raw || typeof raw !== "object") return null;
    const usage = raw as Record<string, unknown>;
    const positiveInteger = (key: string): number => {
        const value = usage[key];
        return typeof value === "number" && Number.isFinite(value) && value > 0
            ? Math.trunc(value)
            : 0;
    };
    const input = positiveInteger("inputTokens");
    const output = positiveInteger("outputTokens");
    const cacheRead = positiveInteger("cacheReadInputTokens");
    if (input === 0 && output === 0 && cacheRead === 0) return null;
    const prompt = input + cacheRead;
    return {
        prompt_tokens: prompt,
        completion_tokens: output,
        total_tokens: prompt + output,
    };
}

export function createPerchSSEToChatTransformer(
    model: string,
    callbacks: PerchStreamCallbacks,
    includeReasoning = true,
) {
    const completionId = randomCompletionId();
    let sentRole = false;
    let nextToolIndex = 0;
    let finished = false;
    const tools = new Map<
        string,
        { index: number; name: string; emittedArgs: boolean }
    >();

    function writeChunk(
        delta: Record<string, unknown>,
        finishReason: string | null = null,
        usage: ChatUsage | null = null,
    ) {
        const chunk: Record<string, unknown> = {
            id: completionId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        if (usage) chunk.usage = usage;
        callbacks.onChunk(chunk);
    }

    function ensureRole() {
        if (sentRole) return;
        writeChunk({ role: "assistant", content: "" });
        sentRole = true;
    }

    function finish(finishReason = "stop", usage: ChatUsage | null = null) {
        if (finished) return;
        finished = true;
        writeChunk({}, finishReason, usage);
        callbacks.onDone();
    }

    return {
        processEvent(rawEvent: unknown) {
            if (finished || !rawEvent || typeof rawEvent !== "object") return;
            const event = rawEvent as PerchEvent;
            const type = stringValue(event.type);

            if (type === "reasoning_delta") {
                if (!includeReasoning) return;
                ensureRole();
                const text = stringValue(event.text);
                if (text) writeChunk({ reasoning_content: text });
                return;
            }

            if (type === "answer_delta") {
                ensureRole();
                const text = stringValue(event.text);
                if (text) writeChunk({ content: text });
                return;
            }

            if (type === "tool_call_delta" || type === "tool_use_end") {
                const sealed = type === "tool_use_end";
                for (const call of eventToolCalls(event)) {
                    const id = stringValue(call.id);
                    if (!id) continue;

                    let state = tools.get(id);
                    if (!state) {
                        ensureRole();
                        const name = stringValue(call.name);
                        state = {
                            index: nextToolIndex++,
                            name,
                            emittedArgs: false,
                        };
                        tools.set(id, state);
                        writeChunk({
                            tool_calls: [
                                {
                                    index: state.index,
                                    id,
                                    type: "function",
                                    function: name ? { name } : {},
                                },
                            ],
                        });
                    }

                    const lateName = stringValue(call.name);
                    if (lateName && !state.name) {
                        state.name = lateName;
                        writeChunk({
                            tool_calls: [
                                {
                                    index: state.index,
                                    function: { name: lateName },
                                },
                            ],
                        });
                    }

                    const rawArguments = stringValue(call.rawArgumentsText);
                    const args =
                        rawArguments || (sealed ? sealedArguments(call) : "");
                    if (!args || (sealed && state.emittedArgs)) continue;
                    state.emittedArgs = true;
                    writeChunk({
                        tool_calls: [
                            {
                                index: state.index,
                                function: { arguments: args },
                            },
                        ],
                    });
                }
                return;
            }

            if (type === "done") {
                const ok = event.ok === true;
                if (!ok) {
                    const message = errorMessage(event);
                    if (message) {
                        ensureRole();
                        writeChunk({ content: message });
                    }
                }
                finish(
                    tools.size > 0 && ok ? "tool_calls" : "stop",
                    usageToChatUsage(event.usage),
                );
            }
        },
        finish() {
            finish();
        },
    };
}

export async function readPerchSSE(
    source: ReadableStream<Uint8Array>,
    onEvent: (event: unknown) => void,
): Promise<void> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const processBlock = (block: string) => {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim();
        if (!data || data === "[DONE]") return;
        try {
            onEvent(JSON.parse(data));
        } catch {
            // Perch occasionally emits keep-alives and non-JSON diagnostics.
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? "";
            for (const block of blocks) processBlock(block);
        }
        buffer += decoder.decode();
        if (buffer.trim()) processBlock(buffer);
    } finally {
        reader.releaseLock();
    }
}

export async function perchSSEToChatCompletion(
    source: ReadableStream<Uint8Array>,
    model: string,
    includeReasoning = true,
): Promise<Record<string, unknown>> {
    let content = "";
    let reasoning = "";
    let usage: ChatUsage | null = null;
    let upstreamError: PerchUpstreamError | null = null;
    const tools: Array<{ id: string; name: string; arguments: string }> = [];
    const toolsById = new Map<string, (typeof tools)[number]>();

    await readPerchSSE(source, (rawEvent) => {
        if (!rawEvent || typeof rawEvent !== "object") return;
        const event = rawEvent as PerchEvent;
        const type = stringValue(event.type);
        if (type === "reasoning_delta" && includeReasoning) {
            reasoning += stringValue(event.text);
        } else if (type === "answer_delta") {
            content += stringValue(event.text);
        } else if (type === "tool_call_delta" || type === "tool_use_end") {
            const sealed = type === "tool_use_end";
            for (const call of eventToolCalls(event)) {
                const id = stringValue(call.id);
                if (!id) continue;
                let tool = toolsById.get(id);
                if (!tool) {
                    tool = { id, name: stringValue(call.name), arguments: "" };
                    toolsById.set(id, tool);
                    tools.push(tool);
                } else if (!tool.name) {
                    tool.name = stringValue(call.name);
                }
                if (sealed) {
                    const args = sealedArguments(call);
                    if (args) tool.arguments = args;
                } else {
                    tool.arguments += stringValue(call.rawArgumentsText);
                }
            }
        } else if (type === "done") {
            const message = errorMessage(event);
            if (message || event.ok === false) {
                upstreamError = new PerchUpstreamError(
                    message || "Perch request failed",
                );
            }
            usage = usageToChatUsage(event.usage);
        }
    });

    if (upstreamError) throw upstreamError;

    const message: Record<string, unknown> = {
        role: "assistant",
        content: content || null,
    };
    if (includeReasoning && reasoning) message.reasoning_content = reasoning;
    if (tools.length > 0) {
        message.tool_calls = tools.map((tool) => ({
            id: tool.id,
            type: "function",
            function: {
                name: tool.name,
                arguments: tool.arguments.trim() ? tool.arguments : "{}",
            },
        }));
    }

    return {
        id: randomCompletionId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message,
                finish_reason: tools.length > 0 ? "tool_calls" : "stop",
            },
        ],
        usage: usage ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        },
    };
}
