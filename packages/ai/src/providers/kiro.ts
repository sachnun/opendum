import type {
    Provider,
    ProviderRequestOptions,
    RefreshedCredentials,
} from "./base.js";
import type { ModelRegistry } from "../registry/registry.js";
import type { ProviderAccount } from "@opendum/database";

const KIRO_REFRESH_ENDPOINT =
    "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken";
const KIRO_USAGE_ENDPOINT = "https://q.us-east-1.amazonaws.com/";
const KIRO_DEFAULT_REGION = "us-east-1";
const KIRO_REFRESH_BUFFER_SECONDS = 300;
const KIRO_THINKING_START = "<thinking>";
const KIRO_THINKING_END = "</thinking>";
const KIRO_THINKING_TAGS = [
    ["<thinking>", "</thinking>"],
    ["<think>", "</think>"],
    ["<reasoning>", "</reasoning>"],
    ["<thought>", "</thought>"],
] as const;

const KIRO_EVENT_STARTS = [
    '{"assistantResponseEvent":',
    '{"toolUseEvent":',
    '{"reasoningContentEvent":',
    '{"metadataEvent":',
    '{"messageMetadataEvent":',
    '{"tokenUsage":',
    '{"usage":',
    '{"content":',
    '{"name":',
    '{"followupPrompt":',
    '{"input":',
    '{"stop":',
    '{"contextUsagePercentage":',
    '{"type":"reasoningContentEvent"',
    '{"text":',
    '{"error":',
    '{"Error":',
    '{"message":',
];

const isRecord = (value: unknown): value is Record<string, any> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
const stringValue = (value: unknown): string =>
    typeof value === "string" ? value : "";
const numberValue = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
const defaultString = (value: unknown, fallback: string): string =>
    stringValue(value) || fallback;
const lastModelSegment = (model: string): string =>
    model.split("/").at(-1) || model;
const joinNonEmpty = (separator: string, ...values: string[]): string =>
    values.filter((value) => value.trim() !== "").join(separator);
const cloneRecord = (value: Record<string, any>): Record<string, any> => ({
    ...value,
});

function randomId(prefix: string): string {
    try {
        return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
    } catch {
        return `${prefix}_${Date.now()}${Math.random().toString(16).slice(2)}`;
    }
}

function normalizeKiroTier(rawType: string, subscriptionTitle: string): string {
    switch (rawType.trim().toUpperCase()) {
        case "Q_DEVELOPER_STANDALONE_FREE":
            return "free";
        case "Q_DEVELOPER_STANDALONE_POWER":
            return "power";
        case "Q_DEVELOPER_STANDALONE_PRO":
            return "pro";
        case "Q_DEVELOPER_STANDALONE_PRO_PLUS":
            return "pro-plus";
        case "Q_DEVELOPER_STANDALONE":
            return "standalone";
    }
    const title = subscriptionTitle.trim().toLowerCase();
    if (!title) return "";
    if (title.includes("pro+") || title.includes("pro plus")) return "pro-plus";
    if (title.includes("power")) return "power";
    if (title.includes("pro")) return "pro";
    if (title.includes("free")) return "free";
    return title.replaceAll(/[_-]+/g, " ").trim().split(/\s+/).join("-");
}

async function fetchKiroSubscriptionTier(accessToken: string): Promise<string> {
    try {
        const response = await fetch(KIRO_USAGE_ENDPOINT, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken.trim()}`,
                "Content-Type": "application/x-amz-json-1.0",
                Accept: "application/json",
                "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
                "User-Agent": "KiroIDE-0.7.45",
            },
            body: JSON.stringify({ origin: "AI_EDITOR" }),
        });
        if (!response.ok) return "";
        const payload: unknown = await response.json();
        if (!isRecord(payload)) return "";
        const data = isRecord(payload.data) ? payload.data : payload;
        const subscription = isRecord(data.subscriptionInfo)
            ? data.subscriptionInfo
            : undefined;
        return subscription
            ? normalizeKiroTier(
                  stringValue(subscription.type),
                  stringValue(subscription.subscriptionTitle),
              )
            : "";
    } catch {
        return "";
    }
}

function contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (isRecord(content)) {
        for (const key of ["text", "input_text", "output_text"]) {
            const value = stringValue(content[key]);
            if (value) return value;
        }
        return content.content !== undefined
            ? contentToText(content.content)
            : "";
    }
    if (!Array.isArray(content)) return "";
    const chunks: string[] = [];
    for (const rawPart of content) {
        if (!isRecord(rawPart)) continue;
        let found = false;
        for (const key of ["text", "input_text", "output_text"]) {
            const value = stringValue(rawPart[key]);
            if (value) {
                chunks.push(value);
                found = true;
                break;
            }
        }
        if (
            !found &&
            rawPart.type === "tool_result" &&
            rawPart.content !== undefined
        ) {
            chunks.push(contentToText(rawPart.content));
        }
    }
    return chunks.join("");
}

function mergeKiroContent(left: unknown, right: unknown): unknown {
    if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
    if (Array.isArray(left)) {
        const text = stringValue(right);
        return text ? [...left, { type: "text", text }] : left;
    }
    if (Array.isArray(right)) {
        const text = stringValue(left);
        return text ? [{ type: "text", text }, ...right] : right;
    }
    return joinNonEmpty("\n", contentToText(left), contentToText(right));
}

function mergeAdjacentKiroMessages(messages: unknown[]): Record<string, any>[] {
    const merged: Record<string, any>[] = [];
    for (const raw of messages) {
        if (!isRecord(raw)) continue;
        const message = cloneRecord(raw);
        const role = stringValue(message.role);
        const previous = merged.at(-1);
        if (
            previous &&
            role !== "tool" &&
            stringValue(previous.role) === role
        ) {
            previous.content = mergeKiroContent(
                previous.content,
                message.content,
            );
            if (
                Array.isArray(message.tool_calls) &&
                message.tool_calls.length > 0
            ) {
                previous.tool_calls = [
                    ...(Array.isArray(previous.tool_calls)
                        ? previous.tool_calls
                        : []),
                    ...message.tool_calls,
                ];
            }
        } else {
            merged.push(message);
        }
    }
    return merged;
}

function normalizeKiroToolMessages(
    messages: Record<string, any>[],
): Record<string, any>[] {
    const normalized: Record<string, any>[] = [];
    let pending: Record<string, any>[] = [];
    const flush = () => {
        if (pending.length > 0) {
            normalized.push({ role: "user", content: pending });
            pending = [];
        }
    };
    for (const message of messages) {
        const role = stringValue(message.role);
        if (role === "tool") {
            pending.push({
                type: "tool_result",
                tool_call_id: defaultString(
                    message.tool_call_id,
                    randomId("toolu"),
                ),
                content: message.content,
            });
            continue;
        }
        if (role === "assistant") {
            flush();
            normalized.push(message);
            continue;
        }
        if (role === "user" && pending.length > 0) {
            normalized.push({
                ...message,
                content: mergeKiroContent(pending, message.content),
            });
            pending = [];
            continue;
        }
        normalized.push(message);
    }
    flush();
    return normalized;
}

function splitKiroSystemMessages(
    messages: unknown[],
): [string, Record<string, any>[]] {
    const system: string[] = [];
    const rest: Record<string, any>[] = [];
    for (const raw of messages) {
        if (!isRecord(raw)) continue;
        const role = stringValue(raw.role);
        if (role === "system" || role === "developer") {
            const text = contentToText(raw.content).trim();
            if (text) system.push(text);
        } else {
            rest.push(raw);
        }
    }
    return [system.join("\n\n"), rest];
}

function convertKiroTools(raw: unknown): unknown[] {
    if (!Array.isArray(raw)) return [];
    const result: unknown[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        let definition = isRecord(item.function) ? item.function : item;
        const name = stringValue(definition.name).trim();
        if (!name) continue;
        const parameters = isRecord(definition.parameters)
            ? definition.parameters
            : isRecord(definition.input_schema)
              ? definition.input_schema
              : { type: "object", properties: {} };
        result.push({
            toolSpecification: {
                name,
                description: stringValue(definition.description).slice(0, 9216),
                inputSchema: { json: parameters },
            },
        });
    }
    return result;
}

function kiroToolResult(id: string, text: string): Record<string, any> {
    return { toolUseId: id, status: "success", content: [{ text }] };
}

function dedupeKiroToolResults(results: unknown[]): Record<string, any>[] {
    const seen = new Set<string>();
    const output: Record<string, any>[] = [];
    for (const result of results) {
        if (!isRecord(result)) continue;
        const id = stringValue(result.toolUseId);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        output.push(result);
    }
    return output;
}

function kiroToolResultsFromContent(content: unknown): Record<string, any>[] {
    if (!Array.isArray(content)) return [];
    const results: Record<string, any>[] = [];
    for (const part of content) {
        if (!isRecord(part) || part.type !== "tool_result") continue;
        const id = defaultString(
            part.tool_use_id,
            stringValue(part.tool_call_id),
        );
        if (id) results.push(kiroToolResult(id, contentToText(part.content)));
    }
    return results;
}

function kiroUserContentAndToolResults(
    content: unknown,
): [string, Record<string, any>[]] {
    if (typeof content === "string" || isRecord(content))
        return [contentToText(content), []];
    if (!Array.isArray(content)) return ["", []];
    const textParts: unknown[] = [];
    const toolResults: Record<string, any>[] = [];
    for (const part of content) {
        if (isRecord(part) && part.type === "tool_result") {
            const id = defaultString(
                part.tool_use_id,
                stringValue(part.tool_call_id),
            );
            if (id)
                toolResults.push(
                    kiroToolResult(id, contentToText(part.content)),
                );
        } else {
            textParts.push(part);
        }
    }
    return [contentToText(textParts), dedupeKiroToolResults(toolResults)];
}

function kiroToolUseFromOpenAICall(
    raw: unknown,
): Record<string, any> | undefined {
    if (!isRecord(raw) || !isRecord(raw.function)) return undefined;
    const id = stringValue(raw.id);
    const name = stringValue(raw.function.name);
    if (!id || !name) return undefined;
    let input: unknown = {};
    const args = stringValue(raw.function.arguments);
    if (args) {
        try {
            input = JSON.parse(args);
        } catch {
            input = {};
        }
    }
    return { toolUseId: id, name, input };
}

function kiroAssistantContentAndToolUses(
    message: Record<string, any>,
): [string, Record<string, any>[]] {
    let content = "";
    let thinking = "";
    const toolUses: Record<string, any>[] = [];
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (!isRecord(part)) continue;
            switch (part.type) {
                case "text":
                case "output_text":
                    content += contentToText(part);
                    break;
                case "thinking":
                    thinking += defaultString(
                        part.thinking,
                        stringValue(part.text),
                    );
                    break;
                case "tool_use": {
                    const id = stringValue(part.id);
                    const name = stringValue(part.name);
                    if (id && name)
                        toolUses.push({
                            toolUseId: id,
                            name,
                            input: part.input ?? {},
                        });
                    break;
                }
            }
        }
    } else {
        content = contentToText(message.content);
    }
    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            const toolUse = kiroToolUseFromOpenAICall(call);
            if (toolUse) toolUses.push(toolUse);
        }
    }
    if (thinking)
        content = joinNonEmpty(
            "\n\n",
            `${KIRO_THINKING_START}${thinking}${KIRO_THINKING_END}`,
            content,
        );
    return [content, toolUses];
}

function convertKiroMessageToHistoryItem(
    raw: unknown,
    modelId: string,
): Record<string, any> | undefined {
    if (!isRecord(raw)) return undefined;
    const role = stringValue(raw.role);
    if (role === "assistant") {
        const [content, toolUses] = kiroAssistantContentAndToolUses(raw);
        if (!content && toolUses.length === 0) return undefined;
        return {
            assistantResponseMessage: {
                content,
                ...(toolUses.length > 0 ? { toolUses } : {}),
            },
        };
    }
    if (role === "tool") {
        const text = contentToText(raw.content);
        let toolResults = kiroToolResultsFromContent(raw.content);
        if (toolResults.length === 0)
            toolResults = [
                kiroToolResult(
                    defaultString(raw.tool_call_id, randomId("toolu")),
                    text,
                ),
            ];
        return {
            userInputMessage: {
                content: "Tool results provided.",
                modelId,
                origin: "AI_EDITOR",
                userInputMessageContext: {
                    toolResults: dedupeKiroToolResults(toolResults),
                },
            },
        };
    }
    if (role === "user") {
        const [rawText, toolResults] = kiroUserContentAndToolResults(
            raw.content,
        );
        const text =
            rawText ||
            (toolResults.length > 0 ? "Tool results provided." : "Continue");
        return {
            userInputMessage: {
                content: text,
                modelId,
                origin: "AI_EDITOR",
                ...(toolResults.length > 0
                    ? { userInputMessageContext: { toolResults } }
                    : {}),
            },
        };
    }
    return undefined;
}

function getKiroToolResults(
    userInput: Record<string, any>,
): Record<string, any>[] {
    const context = isRecord(userInput.userInputMessageContext)
        ? userInput.userInputMessageContext
        : undefined;
    return context && Array.isArray(context.toolResults)
        ? context.toolResults.filter(isRecord)
        : [];
}

function setKiroCurrentToolResults(
    userInput: Record<string, any>,
    results: unknown[],
): void {
    const context = isRecord(userInput.userInputMessageContext)
        ? userInput.userInputMessageContext
        : {};
    const deduped = dedupeKiroToolResults(results);
    if (deduped.length > 0) context.toolResults = deduped;
    else delete context.toolResults;
    if (Object.keys(context).length > 0)
        userInput.userInputMessageContext = context;
    else delete userInput.userInputMessageContext;
}

function kiroHistoryToolUseIds(history: unknown[]): Set<string> {
    const ids = new Set<string>();
    for (const item of history) {
        if (!isRecord(item) || !isRecord(item.assistantResponseMessage))
            continue;
        const uses = item.assistantResponseMessage.toolUses;
        if (!Array.isArray(uses)) continue;
        for (const use of uses)
            if (isRecord(use) && stringValue(use.toolUseId))
                ids.add(stringValue(use.toolUseId));
    }
    return ids;
}

function findOriginalKiroToolCall(
    messages: unknown[],
    toolUseId: string,
): Record<string, any> | undefined {
    for (const message of messages) {
        if (!isRecord(message) || message.role !== "assistant") continue;
        if (Array.isArray(message.tool_calls)) {
            for (const call of message.tool_calls) {
                const use = kiroToolUseFromOpenAICall(call);
                if (use?.toolUseId === toolUseId) return use;
            }
        }
        if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (
                    isRecord(part) &&
                    part.type === "tool_use" &&
                    part.id === toolUseId
                ) {
                    return {
                        toolUseId,
                        name: stringValue(part.name),
                        input: part.input ?? {},
                    };
                }
            }
        }
    }
    return undefined;
}

function kiroToolResultText(result: Record<string, any>): string {
    return contentToText(Array.isArray(result.content) ? result.content : []);
}

function reconcileKiroCurrentToolResults(
    history: unknown[],
    rawMessages: unknown[],
    userInput: Record<string, any>,
    modelId: string,
): unknown[] {
    const rawResults = getKiroToolResults(userInput);
    if (rawResults.length === 0) return history;
    const historyIds = kiroHistoryToolUseIds(history);
    const finalResults: unknown[] = [];
    const orphanedUses: unknown[] = [];
    for (const result of rawResults) {
        const id = stringValue(result.toolUseId);
        if (!id || historyIds.has(id)) {
            finalResults.push(result);
            continue;
        }
        const original = findOriginalKiroToolCall(rawMessages, id);
        if (original) {
            orphanedUses.push(original);
            finalResults.push(result);
            historyIds.add(id);
        } else {
            userInput.content = joinNonEmpty(
                "\n\n",
                stringValue(userInput.content),
                `[Output for tool call ${id}]:\n${kiroToolResultText(result)}`,
            );
        }
    }
    if (orphanedUses.length > 0) {
        const last = history.at(-1);
        if (
            !last ||
            (isRecord(last) && last.assistantResponseMessage !== undefined)
        ) {
            history.push({
                userInputMessage: {
                    content: "Running tools...",
                    modelId,
                    origin: "AI_EDITOR",
                },
            });
        }
        history.push({
            assistantResponseMessage: {
                content: "I will execute the following tools.",
                toolUses: orphanedUses,
            },
        });
    }
    setKiroCurrentToolResults(userInput, finalResults);
    return history;
}

function injectKiroSystemPrompt(
    history: unknown[],
    systemPrompt: string,
): boolean {
    for (const item of history) {
        if (!isRecord(item) || !isRecord(item.userInputMessage)) continue;
        if (getKiroToolResults(item.userInputMessage).length > 0) continue;
        item.userInputMessage.content = joinNonEmpty(
            "\n\n",
            systemPrompt,
            stringValue(item.userInputMessage.content),
        );
        return true;
    }
    return false;
}

function kiroAssistantToolUseIds(
    assistant: Record<string, any>,
): Set<string> | undefined {
    if (!Array.isArray(assistant.toolUses) || assistant.toolUses.length === 0)
        return undefined;
    const ids = new Set<string>();
    for (const use of assistant.toolUses)
        if (isRecord(use) && stringValue(use.toolUseId))
            ids.add(stringValue(use.toolUseId));
    return ids;
}

function filterKiroAssistantToolUses(
    assistant: Record<string, any> | undefined,
    resultIds: Set<string> | undefined,
): void {
    if (!assistant || !Array.isArray(assistant.toolUses)) return;
    const kept = assistant.toolUses.filter(
        (use) => isRecord(use) && resultIds?.has(stringValue(use.toolUseId)),
    );
    if (kept.length > 0) assistant.toolUses = kept;
    else delete assistant.toolUses;
}

function sanitizeKiroUserToolResults(
    user: Record<string, any>,
    allowed: Set<string> | undefined,
): Set<string> | undefined {
    const results = getKiroToolResults(user);
    if (results.length === 0 || !allowed?.size) return undefined;
    const kept: unknown[] = [];
    const keptIds = new Set<string>();
    for (const result of results) {
        const id = stringValue(result.toolUseId);
        if (id && allowed.has(id)) {
            kept.push(result);
            keptIds.add(id);
        } else {
            user.content = joinNonEmpty(
                "\n\n",
                stringValue(user.content),
                `[Output for tool call ${id || "unknown"}]:\n${kiroToolResultText(result)}`,
            );
        }
    }
    setKiroCurrentToolResults(user, kept);
    return keptIds.size > 0 ? keptIds : undefined;
}

function sanitizeKiroToolPairing(
    history: unknown[],
    currentUser: Record<string, any>,
): unknown[] {
    const sanitized: unknown[] = [];
    let pendingAssistant: Record<string, any> | undefined;
    let pendingIds: Set<string> | undefined;
    for (const item of history) {
        if (isRecord(item) && isRecord(item.assistantResponseMessage)) {
            filterKiroAssistantToolUses(pendingAssistant, undefined);
            pendingAssistant = item.assistantResponseMessage;
            pendingIds = kiroAssistantToolUseIds(pendingAssistant);
        } else if (isRecord(item) && isRecord(item.userInputMessage)) {
            const resultIds = sanitizeKiroUserToolResults(
                item.userInputMessage,
                pendingIds,
            );
            filterKiroAssistantToolUses(pendingAssistant, resultIds);
            pendingAssistant = undefined;
            pendingIds = undefined;
        }
        sanitized.push(item);
    }
    const currentIds = sanitizeKiroUserToolResults(currentUser, pendingIds);
    filterKiroAssistantToolUses(pendingAssistant, currentIds);
    return sanitized;
}

function defaultThinkingBudget(effort: string): number {
    switch (effort) {
        case "low":
            return 1024;
        case "medium":
            return 10000;
        case "high":
        case "xhigh":
            return 32000;
        default:
            return 0;
    }
}

function kiroReasoningEffort(body: Record<string, unknown>): string {
    if (isRecord(body.reasoning) && stringValue(body.reasoning.effort))
        return stringValue(body.reasoning.effort);
    return stringValue(body.reasoning_effort);
}

function kiroExplicitThinkingBudget(body: Record<string, unknown>): number {
    const direct = numberValue(body.thinking_budget);
    if (direct > 0) return direct;
    if (isRecord(body.reasoning)) {
        for (const key of ["max_tokens", "budget_tokens", "thinking_budget"]) {
            const value = numberValue(body.reasoning[key]);
            if (value > 0) return value;
        }
    }
    return 0;
}

function kiroIncludeThoughtsFalse(body: Record<string, unknown>): boolean {
    if (body.include_thoughts === false) return true;
    if (isRecord(body.reasoning)) {
        const include =
            body.reasoning.include_thoughts ?? body.reasoning.includeThoughts;
        if (include === false) return true;
    }
    return false;
}

function kiroThinkingBudget(body: Record<string, unknown>): number {
    return (
        kiroExplicitThinkingBudget(body) ||
        defaultThinkingBudget(kiroReasoningEffort(body)) ||
        20000
    );
}

interface ParserState {
    buffer: string;
}

function nextKiroJsonStart(buffer: string, offset: number): number {
    let best = -1;
    for (const pattern of KIRO_EVENT_STARTS) {
        const index = buffer.indexOf(pattern, offset);
        if (index >= 0 && (best < 0 || index < best)) best = index;
    }
    return best;
}

function normalizeKiroResponseEvents(
    event: Record<string, any>,
): Record<string, any>[] {
    const output: Record<string, any>[] = [];
    for (const key of [
        "assistantResponseEvent",
        "toolUseEvent",
        "reasoningContentEvent",
        "metadataEvent",
        "messageMetadataEvent",
        "tokenUsage",
        "usage",
    ]) {
        if (!isRecord(event[key])) continue;
        const normalized: Record<string, any> = { ...event[key], type: key };
        if (key === "reasoningContentEvent")
            normalized.reasoningContentEvent = event[key];
        output.push(normalized);
    }
    return output.length > 0 ? output : [event];
}

function kiroReasoningContent(event: Record<string, any>): string {
    if (isRecord(event.reasoningContentEvent)) {
        return defaultString(
            event.reasoningContentEvent.text,
            stringValue(event.reasoningContentEvent.reasoning_content),
        );
    }
    const text = stringValue(event.text);
    if (
        text &&
        (event.signature !== undefined ||
            event.redactedContent !== undefined ||
            event.redacted_content !== undefined ||
            event.type === "reasoningContentEvent")
    ) {
        return text;
    }
    return "";
}

function firstKiroNumber(values: Record<string, any>, keys: string[]): number {
    for (const key of keys) {
        const value = numberValue(values[key]);
        if (value > 0) return value;
    }
    return 0;
}

function kiroUsage(
    event: Record<string, any>,
): Record<string, number> | undefined {
    let usage = isRecord(event.usage)
        ? event.usage
        : isRecord(event.tokenUsage)
          ? event.tokenUsage
          : undefined;
    if (!usage && event.type === "tokenUsage") usage = event;
    if (!usage) return undefined;
    const input = firstKiroNumber(usage, [
        "inputTokens",
        "input_tokens",
        "promptTokens",
        "prompt_tokens",
    ]);
    const output = firstKiroNumber(usage, [
        "outputTokens",
        "output_tokens",
        "completionTokens",
        "completion_tokens",
    ]);
    if (input <= 0 && output <= 0) return undefined;
    return {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: input + output,
    };
}

function kiroErrorMessage(event: Record<string, any>): string {
    if (
        stringValue(event.message) &&
        (event.error !== undefined || event.Error !== undefined)
    )
        return stringValue(event.message);
    return defaultString(event.error, stringValue(event.Error));
}

function isKiroResponseEvent(event: Record<string, any>): boolean {
    return Boolean(
        kiroReasoningContent(event) ||
        (typeof event.content === "string" &&
            event.followupPrompt === undefined) ||
        (stringValue(event.name) && stringValue(event.toolUseId)) ||
        typeof event.input === "string" ||
        (event.stop !== undefined &&
            event.contextUsagePercentage === undefined) ||
        event.contextUsagePercentage !== undefined ||
        kiroUsage(event) ||
        event.error !== undefined ||
        event.Error !== undefined ||
        event.message !== undefined,
    );
}

function parseKiroJsonEvents(
    source: string,
    state: ParserState,
): Record<string, any>[] {
    state.buffer += source;
    const events: Record<string, any>[] = [];
    let cursor = 0;
    while (cursor < state.buffer.length) {
        const start = nextKiroJsonStart(state.buffer, cursor);
        if (start < 0) {
            state.buffer = state.buffer.slice(cursor).slice(-64);
            return events;
        }
        let depth = 0;
        let inString = false;
        let escaped = false;
        let end = -1;
        for (let index = start; index < state.buffer.length; index++) {
            const char = state.buffer[index]!;
            if (escaped) {
                escaped = false;
                continue;
            }
            if (char === "\\") {
                escaped = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }
            if (inString) continue;
            if (char === "{") depth++;
            else if (char === "}" && --depth === 0) {
                end = index;
                break;
            }
        }
        if (end < 0) {
            state.buffer = state.buffer.slice(start);
            return events;
        }
        const candidate = state.buffer.slice(start, end + 1);
        cursor = end + 1;
        try {
            const parsed: unknown = JSON.parse(candidate);
            if (isRecord(parsed)) {
                for (const event of normalizeKiroResponseEvents(parsed))
                    if (isKiroResponseEvent(event)) events.push(event);
            }
        } catch {
            // Event-stream framing can contain arbitrary binary data between JSON documents.
        }
    }
    state.buffer = "";
    return events;
}

function findKiroRealTag(buffer: string, tag: string): number {
    let position = 0;
    let inCodeBlock = false;
    while (position < buffer.length) {
        const tagPosition = buffer.indexOf(tag, position);
        if (tagPosition < 0) return -1;
        const fencePosition = buffer.indexOf("```", position);
        if (fencePosition >= 0 && fencePosition < tagPosition) {
            inCodeBlock = !inCodeBlock;
            position = fencePosition + 3;
            continue;
        }
        if (!inCodeBlock) return tagPosition;
        position = tagPosition + tag.length;
    }
    return -1;
}

class KiroThinkingSplitter {
    private buffer = "";
    private inThinking = false;
    private thinkingExtracted = false;
    private activeEndTag = "";

    constructor(private enabled: boolean) {}

    process(delta: string, final = false): [string, string] {
        if (!this.enabled) return [delta, ""];
        this.buffer += delta;
        let content = "";
        let reasoning = "";
        while (this.buffer) {
            if (!this.inThinking && !this.thinkingExtracted) {
                let best = -1;
                let matched: (typeof KIRO_THINKING_TAGS)[number] | undefined;
                for (const tag of KIRO_THINKING_TAGS) {
                    const index = findKiroRealTag(this.buffer, tag[0]);
                    if (index >= 0 && (best < 0 || index < best)) {
                        best = index;
                        matched = tag;
                    }
                }
                if (matched) {
                    content += this.buffer.slice(0, best);
                    this.buffer = this.buffer.slice(best + matched[0].length);
                    this.inThinking = true;
                    this.activeEndTag = matched[1];
                    continue;
                }
                if (final) {
                    content += this.buffer;
                    this.buffer = "";
                    break;
                }
                const keep = Math.max(
                    ...KIRO_THINKING_TAGS.map(([start]) => start.length),
                );
                const safeLength = Math.max(0, this.buffer.length - keep);
                if (safeLength > 0) {
                    content += this.buffer.slice(0, safeLength);
                    this.buffer = this.buffer.slice(safeLength);
                }
                break;
            }
            if (this.inThinking) {
                const endTag = this.activeEndTag || KIRO_THINKING_END;
                const end = findKiroRealTag(this.buffer, endTag);
                if (end >= 0) {
                    reasoning += this.buffer.slice(0, end);
                    this.buffer = this.buffer.slice(end + endTag.length);
                    this.inThinking = false;
                    this.thinkingExtracted = true;
                    if (this.buffer.startsWith("\n\n"))
                        this.buffer = this.buffer.slice(2);
                    continue;
                }
                if (final) {
                    reasoning += this.buffer;
                    this.buffer = "";
                    break;
                }
                const safeLength = Math.max(
                    0,
                    this.buffer.length - endTag.length,
                );
                if (safeLength > 0) {
                    reasoning += this.buffer.slice(0, safeLength);
                    this.buffer = this.buffer.slice(safeLength);
                }
                break;
            }
            content += this.buffer;
            this.buffer = "";
        }
        return [content, reasoning];
    }

    flush(): [string, string] {
        return this.process("", true);
    }
}

interface BracketToolCall {
    id: string;
    name: string;
    arguments: string;
    raw: string;
}

function findBalancedJsonEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index]!;
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (char === "{") depth++;
        else if (char === "}" && --depth === 0) return index;
    }
    return -1;
}

function parseKiroBracketToolCalls(text: string): BracketToolCall[] {
    const calls: BracketToolCall[] = [];
    let search = 0;
    while (search < text.length) {
        const start = text.indexOf("[Called ", search);
        if (start < 0) break;
        const nameStart = start + 8;
        const marker = text.indexOf(" with args:", nameStart);
        if (marker < 0) {
            search = nameStart;
            continue;
        }
        const name = text.slice(nameStart, marker).trim();
        let argsStart = marker + 11;
        while ([" ", "\n", "\t"].includes(text[argsStart] || "")) argsStart++;
        if (!name || text[argsStart] !== "{") {
            search = argsStart;
            continue;
        }
        const argsEnd = findBalancedJsonEnd(text, argsStart);
        if (argsEnd < 0) break;
        let close = argsEnd + 1;
        while ([" ", "\n", "\t"].includes(text[close] || "")) close++;
        if (text[close] !== "]") {
            search = argsEnd + 1;
            continue;
        }
        const args = text.slice(argsStart, argsEnd + 1);
        try {
            JSON.parse(args);
            calls.push({
                id: randomId("toolu"),
                name,
                arguments: args,
                raw: text.slice(start, close + 1),
            });
        } catch {
            // Ignore malformed bracket-style tool calls.
        }
        search = close + 1;
    }
    return calls;
}

function cleanKiroBracketToolCalls(
    text: string,
    calls: BracketToolCall[],
): string {
    let cleaned = text;
    for (const call of calls) cleaned = cleaned.replaceAll(call.raw, "");
    return cleaned.trim().split(/\s+/).join(" ");
}

function kiroUsageFromContext(
    model: string,
    percentage: number,
    outputText: string,
): Record<string, number> {
    const completionTokens = outputText ? Math.ceil(outputText.length / 4) : 0;
    const contextWindow = model.includes("-1m") ? 1_000_000 : 200_000;
    const total =
        percentage > 0 ? Math.round((contextWindow * percentage) / 100) : 0;
    const promptTokens = Math.max(0, total - completionTokens);
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
    };
}

function convertKiroEventsToCompletion(
    events: Record<string, any>[],
    model: string,
    parseThinking: boolean,
): Record<string, any> {
    let content = "";
    let reasoning = "";
    let outputText = "";
    let activeToolId = "";
    let contextUsagePercentage = 0;
    let explicitUsage: Record<string, number> | undefined;
    let hasNativeReasoning = false;
    const splitter = new KiroThinkingSplitter(parseThinking);
    const calls = new Map<
        string,
        { index: number; name: string; arguments: string }
    >();
    for (const event of events) {
        if (event.contextUsagePercentage !== undefined)
            contextUsagePercentage = Number(event.contextUsagePercentage) || 0;
        explicitUsage = kiroUsage(event) ?? explicitUsage;
        if (kiroErrorMessage(event)) continue;
        const nativeReasoning = kiroReasoningContent(event);
        if (nativeReasoning) {
            hasNativeReasoning = true;
            reasoning += nativeReasoning;
            outputText += nativeReasoning;
        }
        if (
            typeof event.content === "string" &&
            event.followupPrompt === undefined
        ) {
            const [textDelta, reasoningDelta] = splitter.process(event.content);
            content += textDelta;
            if (!hasNativeReasoning) reasoning += reasoningDelta;
            outputText += textDelta + reasoningDelta;
        }
        const name = stringValue(event.name);
        const id = stringValue(event.toolUseId);
        if (name && id) {
            activeToolId = id;
            if (!calls.has(id))
                calls.set(id, { index: calls.size, name, arguments: "" });
            if (typeof event.input === "string")
                calls.get(id)!.arguments += event.input;
        } else if (typeof event.input === "string" && activeToolId) {
            const call = calls.get(activeToolId);
            if (call) call.arguments += event.input;
        }
        if (event.stop === true) activeToolId = "";
    }
    const [finalContent, finalReasoning] = splitter.flush();
    content += finalContent;
    if (!hasNativeReasoning) reasoning += finalReasoning;
    outputText += finalContent + finalReasoning;

    const toolCalls = [...calls.entries()]
        .sort((left, right) => left[1].index - right[1].index)
        .map(([id, call]) => ({
            id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" },
        }));
    const bracketCalls = parseKiroBracketToolCalls(content);
    if (bracketCalls.length > 0) {
        content = cleanKiroBracketToolCalls(content, bracketCalls);
        for (const call of bracketCalls) {
            toolCalls.push({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
            });
        }
    }
    const message: Record<string, any> = {
        role: "assistant",
        content: content || null,
    };
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return {
        id: randomId("chatcmpl"),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message,
                finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
            },
        ],
        usage:
            explicitUsage ??
            kiroUsageFromContext(model, contextUsagePercentage, outputText),
    };
}

function createKiroSseStream(
    source: ReadableStream<Uint8Array>,
    model: string,
    parseThinking: boolean,
): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            const state: ParserState = { buffer: "" };
            const splitter = new KiroThinkingSplitter(parseThinking);
            const completionId = randomId("chatcmpl");
            const created = Math.floor(Date.now() / 1000);
            const toolIndexes = new Map<string, number>();
            let sentRole = false;
            let toolCallCount = 0;
            let activeToolId = "";
            let hasNativeReasoning = false;
            let totalContent = "";
            let outputText = "";
            let contextUsagePercentage = 0;
            let explicitUsage: Record<string, number> | undefined;
            const write = (
                delta: Record<string, any>,
                finishReason: string | null,
                usage?: Record<string, number>,
            ) => {
                const chunk: Record<string, any> = {
                    id: completionId,
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
            const ensureRole = () => {
                if (!sentRole) {
                    write({ role: "assistant", content: "" }, null);
                    sentRole = true;
                }
            };
            const emit = (contentDelta: string, reasoningDelta: string) => {
                if (reasoningDelta) {
                    ensureRole();
                    outputText += reasoningDelta;
                    write({ reasoning_content: reasoningDelta }, null);
                }
                if (contentDelta) {
                    ensureRole();
                    outputText += contentDelta;
                    write({ content: contentDelta }, null);
                }
            };
            const process = (event: Record<string, any>) => {
                if (event.contextUsagePercentage !== undefined) {
                    contextUsagePercentage =
                        Number(event.contextUsagePercentage) || 0;
                    return;
                }
                const usage = kiroUsage(event);
                if (usage) {
                    explicitUsage = usage;
                    return;
                }
                if (kiroErrorMessage(event)) return;
                const nativeReasoning = kiroReasoningContent(event);
                if (nativeReasoning) {
                    hasNativeReasoning = true;
                    emit("", nativeReasoning);
                    return;
                }
                if (
                    typeof event.content === "string" &&
                    event.followupPrompt === undefined
                ) {
                    totalContent += event.content;
                    const [contentDelta, splitReasoning] = splitter.process(
                        event.content,
                    );
                    emit(
                        contentDelta,
                        hasNativeReasoning ? "" : splitReasoning,
                    );
                }
                const name = stringValue(event.name);
                const id = stringValue(event.toolUseId);
                if (name && id) {
                    ensureRole();
                    let index = toolIndexes.get(id);
                    if (index === undefined) {
                        index = toolCallCount++;
                        toolIndexes.set(id, index);
                    }
                    activeToolId = id;
                    write(
                        {
                            tool_calls: [
                                {
                                    index,
                                    id,
                                    type: "function",
                                    function: { name, arguments: "" },
                                },
                            ],
                        },
                        null,
                    );
                    if (typeof event.input === "string" && event.input) {
                        write(
                            {
                                tool_calls: [
                                    {
                                        index,
                                        function: { arguments: event.input },
                                    },
                                ],
                            },
                            null,
                        );
                    }
                } else if (
                    typeof event.input === "string" &&
                    event.input &&
                    activeToolId
                ) {
                    const index = toolIndexes.get(activeToolId);
                    if (index !== undefined) {
                        ensureRole();
                        write(
                            {
                                tool_calls: [
                                    {
                                        index,
                                        function: { arguments: event.input },
                                    },
                                ],
                            },
                            null,
                        );
                    }
                }
                if (event.stop === true) activeToolId = "";
            };

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    for (const event of parseKiroJsonEvents(
                        decoder.decode(value, { stream: true }),
                        state,
                    ))
                        process(event);
                }
                const decoderTail = decoder.decode();
                for (const event of parseKiroJsonEvents(decoderTail, state))
                    process(event);
                for (const event of parseKiroJsonEvents("", state))
                    process(event);
                const [finalContent, finalReasoning] = splitter.flush();
                emit(finalContent, hasNativeReasoning ? "" : finalReasoning);
                for (const call of parseKiroBracketToolCalls(totalContent)) {
                    const index = toolCallCount++;
                    write(
                        {
                            tool_calls: [
                                {
                                    index,
                                    id: call.id,
                                    type: "function",
                                    function: {
                                        name: call.name,
                                        arguments: "",
                                    },
                                },
                            ],
                        },
                        null,
                    );
                    write(
                        {
                            tool_calls: [
                                {
                                    index,
                                    function: { arguments: call.arguments },
                                },
                            ],
                        },
                        null,
                    );
                }
                write(
                    {},
                    toolCallCount > 0 ? "tool_calls" : "stop",
                    explicitUsage ??
                        kiroUsageFromContext(
                            model,
                            contextUsagePercentage,
                            outputText,
                        ),
                );
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
            } catch (error) {
                controller.error(error);
            }
        },
        async cancel(reason) {
            await reader.cancel(reason);
        },
    });
}

export class KiroProvider implements Provider {
    public name = "kiro";

    constructor(private registry: ModelRegistry) {}

    getRefreshBuffer(): number {
        return KIRO_REFRESH_BUFFER_SECONDS;
    }

    async refreshCredentials(
        refreshToken: string,
        _account: ProviderAccount,
    ): Promise<RefreshedCredentials> {
        const response = await fetch(KIRO_REFRESH_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                "User-Agent": "KiroIDE",
            },
            body: JSON.stringify({ refreshToken: refreshToken.trim() }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(
                `kiro token refresh failed: ${response.status} ${text}`,
            );
        }
        const data: unknown = await response.json();
        if (!isRecord(data) || !stringValue(data.accessToken).trim()) {
            throw new Error("kiro token refresh returned empty access token");
        }
        const accessToken = stringValue(data.accessToken);
        const expiresIn =
            numberValue(data.expiresIn) > 0
                ? numberValue(data.expiresIn)
                : 3600;
        const tier = await fetchKiroSubscriptionTier(accessToken);
        return {
            accessToken,
            refreshToken: stringValue(data.refreshToken) || refreshToken,
            expiresAt: new Date(Date.now() + expiresIn * 1000),
            tier,
        };
    }

    private normalizeModel(model: string): string {
        const raw = lastModelSegment(model);
        if (this.registry.isModelSupportedByProvider(raw, "kiro")) {
            return this.registry.upstreamModelName(raw, "kiro");
        }
        if (raw.endsWith("-thinking")) {
            const base = raw.slice(0, -"-thinking".length);
            if (this.registry.isModelSupportedByProvider(base, "kiro")) {
                return this.registry.upstreamModelName(base, "kiro");
            }
        }
        return this.registry.upstreamModelName(raw, "kiro");
    }

    private thinkingRequested(body: Record<string, unknown>): boolean {
        if (
            kiroIncludeThoughtsFalse(body) ||
            kiroReasoningEffort(body) === "none"
        )
            return false;
        if (kiroExplicitThinkingBudget(body) > 0) return true;
        const effort = kiroReasoningEffort(body);
        if (effort) return defaultThinkingBudget(effort) > 0;
        if (body.include_thoughts === true || body._includeReasoning === true)
            return true;
        const model = stringValue(body.model);
        const raw = lastModelSegment(model);
        if (raw.endsWith("-thinking")) return true;
        if (
            this.registry.getModel(model)?.meta?.reasoning ||
            this.registry.getModel(raw)?.meta?.reasoning
        )
            return true;
        return [
            "thinking_budget",
            "include_thoughts",
            "reasoning",
            "reasoning_effort",
        ].some((key) => body[key] !== undefined && body[key] !== null);
    }

    private buildRequest(body: Record<string, unknown>): Record<string, any> {
        const modelId = this.normalizeModel(stringValue(body.model));
        const conversationId = randomId("conversation");
        const tools = convertKiroTools(body.tools);
        const rawMessages = Array.isArray(body.messages) ? body.messages : [];
        let [systemPrompt, messages] = splitKiroSystemMessages(rawMessages);
        const instructions = stringValue(body.instructions).trim();
        if (instructions)
            systemPrompt = joinNonEmpty("\n\n", instructions, systemPrompt);
        if (
            this.thinkingRequested(body) &&
            !systemPrompt.includes("<thinking_mode>")
        ) {
            const prefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${kiroThinkingBudget(body)}</max_thinking_length>`;
            systemPrompt = joinNonEmpty("\n", prefix, systemPrompt);
        }
        messages = normalizeKiroToolMessages(
            mergeAdjacentKiroMessages(messages),
        );

        let history: unknown[] = [];
        for (const message of messages.slice(0, -1)) {
            const item = convertKiroMessageToHistoryItem(message, modelId);
            if (item) history.push(item);
        }
        let currentContent = "Continue";
        const currentContext: Record<string, any> = {};
        const last = messages.at(-1);
        if (last) {
            if (last.role === "assistant") {
                const item = convertKiroMessageToHistoryItem(last, modelId);
                if (item) history.push(item);
                currentContent = "[system: conversation continues]";
            } else {
                const [text, toolResults] = kiroUserContentAndToolResults(
                    last.content,
                );
                currentContent =
                    text ||
                    (toolResults.length > 0
                        ? "Tool results provided."
                        : "Continue");
                if (toolResults.length > 0)
                    currentContext.toolResults = toolResults;
            }
        }
        if (tools.length > 0) currentContext.tools = tools;
        const userInput: Record<string, any> = {
            content: currentContent,
            modelId,
            origin: "AI_EDITOR",
        };
        if (Object.keys(currentContext).length > 0)
            userInput.userInputMessageContext = currentContext;
        history = reconcileKiroCurrentToolResults(
            history,
            rawMessages,
            userInput,
            modelId,
        );
        const historyLast = history.at(-1);
        if (
            historyLast &&
            isRecord(historyLast) &&
            historyLast.assistantResponseMessage === undefined
        ) {
            history.push({
                assistantResponseMessage: {
                    content: "[system: conversation continues]",
                },
            });
        }
        if (
            systemPrompt &&
            !injectKiroSystemPrompt(history, systemPrompt) &&
            getKiroToolResults(userInput).length === 0
        ) {
            userInput.content = joinNonEmpty(
                "\n\n",
                systemPrompt,
                stringValue(userInput.content),
            );
        }
        history = sanitizeKiroToolPairing(history, userInput);
        const conversationState: Record<string, any> = {
            chatTriggerType: "MANUAL",
            conversationId,
            currentMessage: { userInputMessage: userInput },
        };
        if (history.length > 0) conversationState.history = history;
        return { conversationState };
    }

    async makeRequest(options: ProviderRequestOptions): Promise<Response> {
        const { account, credentials, body, stream, signal } = options;
        const rawModel = lastModelSegment(stringValue(body.model));
        const thinkingEnabled = this.thinkingRequested(body);
        const payload = this.buildRequest(body);
        const profileArn = account.accountId?.trim();
        if (profileArn) payload.profileArn = profileArn;
        const region =
            profileArn?.split(":")[0] === "arn" && profileArn.split(":")[3]
                ? profileArn.split(":")[3]
                : KIRO_DEFAULT_REGION;
        const response = await fetch(
            `https://q.${region}.amazonaws.com/generateAssistantResponse`,
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${credentials?.trim()}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "User-Agent":
                        "aws-sdk-js/3.738.0 ua/2.1 lang/go api/codewhisperer#3.738.0 m/E KiroIDE",
                    "x-amz-user-agent": "aws-sdk-js/3.738.0 KiroIDE",
                    "x-amzn-codewhisperer-optout": "true",
                    "x-amzn-kiro-agent-mode": "vibe",
                    "amz-sdk-invocation-id": randomId("kiro"),
                    "amz-sdk-request": "attempt=1; max=1",
                    Connection: "close",
                },
                body: JSON.stringify(payload),
                signal,
            },
        );
        if (!response.ok) return response;
        if (!response.body) {
            return Response.json(
                {
                    error: {
                        message: "Kiro response stream is empty",
                        type: "api_error",
                    },
                },
                { status: 502 },
            );
        }
        if (stream) {
            return new Response(
                createKiroSseStream(response.body, rawModel, thinkingEnabled),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "text/event-stream",
                        "Cache-Control": "no-cache",
                        Connection: "keep-alive",
                    },
                },
            );
        }
        const decoder = new TextDecoder();
        const events = parseKiroJsonEvents(
            decoder.decode(await response.arrayBuffer()),
            { buffer: "" },
        );
        return Response.json(
            convertKiroEventsToCompletion(events, rawModel, thinkingEnabled),
            { status: 200 },
        );
    }
}

export default KiroProvider;
