import { randomUUID, createHash } from "node:crypto";
import { getCachedSignatureSync, cacheSignatureSync } from "./cache.js";
import { BASE_SYSTEM_INSTRUCTION, isImageGenerationModel } from "./helpers.js";
import type { RequestPayload, ModelFamily, ToolSchemaMap } from "./types.js";

export interface AntigravityTransformOptions {
    config?: Record<string, unknown>;
}

type JsonObject = Record<string, any>;

const TOOL_SCHEMA_INSTRUCTION = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field.
4. **NESTED OBJECTS**: When items.type is "object", include exact required nested fields.
5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ...".
6. **BEFORE EVERY TOOL CALL**: Read tool schema and verify exact required params.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>

## GEMINI 3 RESPONSE RULES
- Default to a direct, concise answer; add detail only when asked or required for correctness.
- For multi-part tasks, use a short numbered list or labeled sections.
- For long provided context, answer only from that context and avoid assumptions.
- For multimodal inputs, explicitly reference each modality used and synthesize across them; do not invent details from absent modalities.
- For complex tasks, outline a short plan and verify constraints before acting.
`;

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

function number(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function modelFamily(
    model: string,
    config: Record<string, unknown>,
): ModelFamily {
    const configured = text(config.signature_family);
    if (
        configured === "claude" ||
        configured === "gemini-flash" ||
        configured === "gemini-pro"
    ) {
        return configured;
    }
    const normalized = model.toLowerCase();
    return normalized.includes("claude")
        ? "claude"
        : normalized.includes("flash")
          ? "gemini-flash"
          : "gemini-pro";
}

function sanitizeToolName(name: string): string {
    return /^\d/.test(name) ? `t_${name}` : name;
}

function randomId(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function normalizeSchemaType(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return (
            value.find((item) => typeof item === "string" && item !== "null") ??
            text(value[0])
        );
    }
    return "";
}

function sanitizeGoogleSchema(schema: JsonObject): JsonObject {
    const out: JsonObject = {};
    const allowed = new Set([
        "description",
        "format",
        "nullable",
        "enum",
        "required",
        "propertyOrdering",
        "minimum",
        "maximum",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "pattern",
        "title",
        "default",
        "example",
        "minProperties",
        "maxProperties",
    ]);
    for (const [key, value] of Object.entries(schema)) {
        if (key === "type") {
            const type = normalizeSchemaType(value);
            if (type) out.type = type;
        } else if (key === "properties" && object(value)) {
            const properties = Object.fromEntries(
                Object.entries(value)
                    .filter(
                        (entry): entry is [string, JsonObject] =>
                            !!object(entry[1]),
                    )
                    .map(([name, property]) => [
                        name,
                        sanitizeGoogleSchema(property),
                    ]),
            );
            if (Object.keys(properties).length) out.properties = properties;
        } else if (key === "items" && object(value)) {
            out.items = sanitizeGoogleSchema(value);
        } else if (key === "anyOf") {
            const items = array(value)
                .map(object)
                .filter((item): item is JsonObject => !!item)
                .map(sanitizeGoogleSchema);
            if (items.length) out.anyOf = items;
        } else if (allowed.has(key)) {
            out[key] = value;
        }
    }
    if (
        Array.isArray(schema.type) &&
        schema.type.includes("null") &&
        out.nullable === undefined
    )
        out.nullable = true;
    if (schema.const !== undefined && out.enum === undefined)
        out.enum = [schema.const];
    if (!out.type)
        out.type = out.properties ? "object" : out.items ? "array" : undefined;
    return out;
}

function schemaScore(schema: JsonObject): number {
    const type = normalizeSchemaType(schema.type);
    if (type === "object") return object(schema.properties) ? 60 : 50;
    if (type === "array") return schema.items ? 45 : 40;
    if (type === "string") return Array.isArray(schema.enum) ? 35 : 30;
    if (type === "number" || type === "integer") return 20;
    if (type === "boolean") return 10;
    return schema.properties
        ? 55
        : schema.items
          ? 42
          : schema.const !== undefined || schema.enum
            ? 32
            : 1;
}

function flattenClaudeUnion(schema: JsonObject): JsonObject {
    for (const key of ["anyOf", "oneOf", "allOf"]) {
        const options = array(schema[key])
            .map(object)
            .filter((item): item is JsonObject => !!item);
        if (!options.length) continue;
        const values: unknown[] = [];
        let allEnum = true;
        for (const option of options) {
            if (normalizeSchemaType(option.type) === "null") continue;
            if (option.const !== undefined) values.push(option.const);
            else if (Array.isArray(option.enum)) values.push(...option.enum);
            else allEnum = false;
        }
        const base = Object.fromEntries(
            Object.entries(schema).filter(
                ([name]) => !["anyOf", "oneOf", "allOf"].includes(name),
            ),
        );
        if (allEnum && values.length)
            return {
                ...base,
                type: base.type ?? typeof values[0],
                enum: values,
            };
        const best =
            [...options]
                .filter((option) => normalizeSchemaType(option.type) !== "null")
                .sort((a, b) => schemaScore(b) - schemaScore(a))[0] ?? {};
        return { ...base, ...best };
    }
    return schema;
}

function sanitizeClaudeSchema(input: JsonObject): JsonObject {
    const schema = flattenClaudeUnion(input);
    const out: JsonObject = {};
    const type = normalizeSchemaType(schema.type);
    if (type) out.type = type;
    if (typeof schema.description === "string")
        out.description = schema.description;
    if (Array.isArray(schema.enum)) out.enum = schema.enum;
    else if (schema.const !== undefined) out.enum = [schema.const];
    if (object(schema.properties)) {
        out.properties = Object.fromEntries(
            Object.entries(schema.properties)
                .filter(
                    (entry): entry is [string, JsonObject] =>
                        !!object(entry[1]),
                )
                .map(([name, property]) => [
                    name,
                    sanitizeClaudeSchema(property),
                ]),
        );
    }
    if (object(schema.items)) out.items = sanitizeClaudeSchema(schema.items);
    out.type ??= out.properties
        ? "object"
        : out.items
          ? "array"
          : out.enum
            ? typeof out.enum[0]
            : "object";
    if (out.type === "object") {
        out.properties ??= {};
        out.required = array(schema.required).filter(
            (name) => typeof name === "string" && name in out.properties,
        );
    }
    if (out.type === "array") out.items ??= {};
    return out;
}

function summarizeSchema(schema: JsonObject, depth = 2): string {
    const type = normalizeSchemaType(schema.type) || "unknown";
    if (type === "array")
        return `array[${depth > 0 ? summarizeSchema(object(schema.items) ?? {}, depth - 1) : "unknown"}]`;
    if (type === "object") {
        const properties = object(schema.properties) ?? {};
        if (!Object.keys(properties).length || depth <= 0) return "object";
        const required = new Set(array(schema.required).map(text));
        const keys = Object.keys(properties)
            .sort(
                (a, b) =>
                    Number(required.has(b)) - Number(required.has(a)) ||
                    a.localeCompare(b),
            )
            .slice(0, 8);
        return `{${keys.map((key) => `${key}: ${summarizeSchema(object(properties[key]) ?? {}, depth - 1)}${required.has(key) ? " REQUIRED" : ""}`).join(", ")}}`;
    }
    return Array.isArray(schema.enum)
        ? `${type} enum(${schema.enum.slice(0, 6).join("|")})`
        : type;
}

function openAIContentParts(content: unknown): JsonObject[] {
    if (typeof content === "string") return content ? [{ text: content }] : [];
    const parts: JsonObject[] = [];
    for (const raw of array(content)) {
        const item = object(raw);
        if (!item) continue;
        if (typeof item.text === "string" && item.text)
            parts.push({ text: item.text });
        else if (item.type === "image_url") {
            const url = text(object(item.image_url)?.url);
            if (!url) continue;
            if (url.startsWith("data:")) {
                const comma = url.indexOf(",");
                if (comma > 0)
                    parts.push({
                        inlineData: {
                            mimeType:
                                url.slice(5, comma).split(";")[0] ||
                                "image/png",
                            data: url.slice(comma + 1),
                        },
                    });
            } else {
                const extension = url
                    .split(/[?#]/)[0]
                    ?.split(".")
                    .pop()
                    ?.toLowerCase();
                const mimeType =
                    extension === "png"
                        ? "image/png"
                        : extension === "gif"
                          ? "image/gif"
                          : extension === "webp"
                            ? "image/webp"
                            : "image/jpeg";
                parts.push({ fileData: { fileUri: url, mimeType } });
            }
        }
    }
    return parts;
}

function openAIToGemini(body: JsonObject): RequestPayload {
    const messages = array(body.messages)
        .map(object)
        .filter((message): message is JsonObject => !!message);
    const completed = new Set(
        messages
            .filter((message) => message.role === "tool")
            .map((message) => text(message.tool_call_id))
            .filter(Boolean),
    );
    const functionNames = new Map<string, string>();
    for (const message of messages) {
        for (const rawCall of array(message.tool_calls)) {
            const call = object(rawCall);
            const id = text(call?.id);
            const name = text(object(call?.function)?.name);
            if (id && name) functionNames.set(id, name);
        }
    }
    const contents: JsonObject[] = [];
    const systemParts: JsonObject[] = [];
    for (const message of messages) {
        const role = text(message.role);
        if (role === "system" || role === "developer") {
            systemParts.push(
                ...openAIContentParts(message.content).filter(
                    (part) => typeof part.text === "string",
                ),
            );
            continue;
        }
        let parts = openAIContentParts(message.content);
        if (role === "assistant" && text(message.reasoning_content))
            parts.unshift({ text: message.reasoning_content, thought: true });
        if (role === "assistant") {
            for (const rawCall of array(message.tool_calls)) {
                const call = object(rawCall);
                const fn = object(call?.function);
                const id = text(call?.id);
                if (!fn || !text(fn.name) || (id && !completed.has(id)))
                    continue;
                let args: unknown = {};
                try {
                    args = JSON.parse(text(fn.arguments) || "{}");
                } catch {
                    /* Preserve an empty argument object. */
                }
                parts.push({ functionCall: { name: text(fn.name), args, id } });
            }
        } else if (role === "tool") {
            const id = text(message.tool_call_id);
            const name =
                text(message.name) || functionNames.get(id) || "unknown";
            if (!id || !functionNames.has(id)) continue;
            parts = [
                {
                    functionResponse: {
                        name,
                        id,
                        response: { result: message.content },
                    },
                },
            ];
        }
        if (parts.length)
            contents.push({
                role: role === "assistant" ? "model" : "user",
                parts,
            });
    }

    const generationConfig: JsonObject = {};
    if (body.temperature !== undefined)
        generationConfig.temperature = body.temperature;
    if (body.top_p !== undefined) generationConfig.topP = body.top_p;
    if (body.max_tokens !== undefined)
        generationConfig.maxOutputTokens = body.max_tokens;
    if (body.stop !== undefined)
        generationConfig.stopSequences = Array.isArray(body.stop)
            ? body.stop
            : [body.stop];
    const effort =
        text(object(body.reasoning)?.effort) || text(body.reasoning_effort);
    const budget =
        number(body.thinking_budget) ||
        ({ low: 1024, medium: 10000, high: 32000, xhigh: 32000 }[effort] ?? 0);
    if (budget > 0)
        generationConfig.thinkingConfig = {
            thinkingBudget: budget,
            ...(body.include_thoughts !== undefined
                ? { include_thoughts: body.include_thoughts }
                : {}),
        };

    const declarations = array(body.tools)
        .map(object)
        .filter((tool): tool is JsonObject => !!tool)
        .map((tool) => object(tool.function))
        .filter((fn): fn is JsonObject => !!fn && !!text(fn.name))
        .map((fn) => ({
            name: text(fn.name),
            description: text(fn.description),
            parameters: sanitizeGoogleSchema(
                object(fn.parameters) ?? { type: "object", properties: {} },
            ),
        }));
    const payload: RequestPayload = { contents };
    if (systemParts.length) payload.systemInstruction = { parts: systemParts };
    if (Object.keys(generationConfig).length)
        payload.generationConfig = generationConfig;
    if (declarations.length)
        payload.tools = [{ functionDeclarations: declarations }];
    for (const key of [
        "cached_content",
        "cachedContent",
        "extra_body",
        "system_instruction",
    ])
        if (body[key] !== undefined) payload[key] = body[key];
    return payload;
}

function normalizeThinking(
    payload: RequestPayload,
    model: string,
    config: Record<string, unknown>,
): void {
    if (isImageGenerationModel(model)) {
        if (payload.generationConfig)
            delete payload.generationConfig.thinkingConfig;
        return;
    }
    const isGemini3 =
        model.toLowerCase().split("/").pop()?.startsWith("gemini-3") === true;
    const generation =
        payload.generationConfig ??
        (config.thinking_model === true || model.endsWith("-tiered")
            ? (payload.generationConfig = {})
            : undefined);
    if (!generation) return;
    const raw = object(generation.thinkingConfig) ?? {};
    if (isGemini3) {
        let level = text(raw.thinkingLevel || raw.thinking_level).toLowerCase();
        const budget = number(raw.thinkingBudget || raw.thinking_budget);
        if (!level && budget)
            level =
                budget <= 8192 ? "low" : budget <= 16384 ? "medium" : "high";
        if (!level)
            level =
                ["minimal", "low", "medium", "high"].find((item) =>
                    model.toLowerCase().endsWith(`-${item}`),
                ) ?? (model.endsWith("-tiered") ? "medium" : "");
        if (level === "xhigh") level = "high";
        if (level === "minimal" && model.toLowerCase().includes("pro"))
            level = "low";
        if (
            level === "medium" &&
            model.toLowerCase().includes("pro") &&
            !model.toLowerCase().includes("gemini-3.1-pro")
        )
            level = "high";
        if (level)
            generation.thinkingConfig = {
                thinkingLevel: level,
                includeThoughts:
                    raw.includeThoughts ?? raw.include_thoughts ?? true,
            };
        else delete generation.thinkingConfig;
        const budgets = object(config.thinking_budgets) ?? {};
        const configuredBudget = number(budgets[level]);
        if (
            configuredBudget &&
            number(
                generation.maxOutputTokens ?? generation.max_output_tokens,
            ) <= configuredBudget
        ) {
            generation.maxOutputTokens = 64000;
            delete generation.max_output_tokens;
        }
        return;
    }
    if (config.thinking_model === true) {
        const budget =
            number(raw.thinkingBudget ?? raw.thinking_budget) || 16384;
        generation.thinkingConfig =
            config.strict_tool_schema === true
                ? {
                      thinking_budget: budget,
                      include_thoughts:
                          raw.includeThoughts ?? raw.include_thoughts ?? true,
                  }
                : {
                      thinkingBudget: budget,
                      include_thoughts:
                          raw.includeThoughts ?? raw.include_thoughts ?? true,
                  };
        if (
            number(
                generation.maxOutputTokens ?? generation.max_output_tokens,
            ) <= budget
        )
            generation.maxOutputTokens = 64000;
    }
}

function normalizeTools(payload: RequestPayload, strict: boolean): void {
    const declarations = array(
        object(array(payload.tools)[0])?.functionDeclarations,
    )
        .map(object)
        .filter((declaration): declaration is JsonObject => !!declaration);
    for (const declaration of declarations) {
        const schema = object(declaration.parametersJsonSchema) ??
            object(declaration.parameters) ?? {
                type: "object",
                properties: {},
            };
        if (strict) {
            declaration.parameters = sanitizeClaudeSchema(schema);
            delete declaration.parametersJsonSchema;
        } else {
            declaration.name = sanitizeToolName(text(declaration.name));
            if (!text(declaration.description).includes("STRICT PARAMETERS:")) {
                const summary = summarizeSchema(schema);
                declaration.description = `${text(declaration.description).trim()}${text(declaration.description) ? "\n\n" : ""}STRICT PARAMETERS: ${summary}`;
            }
        }
    }
    declarations.sort((a, b) => text(a.name).localeCompare(text(b.name)));
    if (!strict && declarations.length) {
        const existing = object(payload.systemInstruction) ?? {};
        const parts = array(existing.parts);
        if (
            !parts.some((part) =>
                text(object(part)?.text).includes(
                    "<CRITICAL_TOOL_USAGE_INSTRUCTIONS>",
                ),
            )
        ) {
            payload.systemInstruction = {
                ...existing,
                parts: [{ text: TOOL_SCHEMA_INSTRUCTION }, ...parts],
            };
        }
    }
}

function normalizeContents(
    payload: RequestPayload,
    model: string,
    sessionId: string,
    config: Record<string, unknown>,
): void {
    const strict = config.strict_tool_schema === true;
    const family = modelFamily(model, config);
    const callIds = new Set<string>();
    const responseIds = new Set<string>();
    const normalized: JsonObject[] = [];
    for (const rawContent of array(payload.contents)) {
        const content = object(rawContent);
        if (!content) continue;
        const parts: JsonObject[] = [];
        let currentSignature = "";
        for (const rawPart of array(content.parts)) {
            const part = object(rawPart);
            if (!part || part.text === "") continue;
            if (part.thought === true) {
                const thought = text(part.text);
                let signature = text(part.thoughtSignature);
                if (!signature || signature.length < 50)
                    signature =
                        getCachedSignatureSync(family, sessionId, thought) ??
                        "";
                if (signature.length > 50) {
                    part.thoughtSignature = signature;
                    currentSignature = signature;
                    cacheSignatureSync(family, sessionId, thought, signature);
                } else if (strict || !signature) continue;
            }
            const call = object(part.functionCall);
            if (call) {
                call.id ||= randomId(text(call.name) || "call");
                callIds.add(text(call.id));
                if (
                    !strict &&
                    config.inject_thought_signature === true &&
                    !part.thoughtSignature
                )
                    part.thoughtSignature =
                        currentSignature || "skip_thought_signature_validator";
            }
            const response = object(part.functionResponse);
            if (response) {
                response.id ||= randomId(text(response.name) || "response");
                responseIds.add(text(response.id));
            }
            if (!strict && part.thoughtSignature && !call)
                delete part.thoughtSignature;
            parts.push(part);
        }
        if (parts.length) normalized.push({ ...content, parts });
    }
    if (strict || config.sanitize_tool_blocks === true) {
        payload.contents = normalized
            .map((content) => ({
                ...content,
                parts: array(content.parts).filter((raw) => {
                    const part = object(raw)!;
                    const call = object(part.functionCall);
                    const response = object(part.functionResponse);
                    return (
                        (!call || responseIds.has(text(call.id))) &&
                        (!response || callIds.has(text(response.id)))
                    );
                }),
            }))
            .filter((content) => content.parts.length);
    } else payload.contents = normalized;
}

export function buildToolSchemaMap(payload: RequestPayload): ToolSchemaMap {
    const result: ToolSchemaMap = {};
    for (const rawTool of array(payload.tools)) {
        for (const rawDeclaration of array(
            object(rawTool)?.functionDeclarations,
        )) {
            const declaration = object(rawDeclaration);
            if (!declaration) continue;
            const name = text(declaration.name);
            const schema =
                object(declaration.parametersJsonSchema) ??
                object(declaration.parameters);
            if (!name || !schema) continue;
            const entry = {
                type: normalizeSchemaType(schema.type),
                description: text(declaration.description),
                parameters: object(schema.properties),
            };
            result[name] = entry;
            result[sanitizeToolName(name)] = entry;
        }
    }
    return result;
}

export function transformAntigravityRequest(
    payload: RequestPayload,
    model: string,
    sessionId: string,
    options: AntigravityTransformOptions = {},
): RequestPayload {
    const config = options.config ?? {};
    const transformed =
        "messages" in payload
            ? openAIToGemini({ ...payload })
            : structuredClone(payload);
    delete transformed.safetySettings;
    if (transformed.system_instruction !== undefined) {
        transformed.systemInstruction = transformed.system_instruction;
        delete transformed.system_instruction;
    }
    const extra = object(transformed.extra_body);
    transformed.cachedContent =
        text(
            extra?.cached_content ??
                extra?.cachedContent ??
                transformed.cached_content ??
                transformed.cachedContent,
        ) || undefined;
    delete transformed.cached_content;
    delete transformed.extra_body;
    delete transformed.model;
    transformed.toolConfig = {
        ...(object(transformed.toolConfig) ?? {}),
        functionCallingConfig: {
            ...(object(object(transformed.toolConfig)?.functionCallingConfig) ??
                {}),
            mode: "VALIDATED",
        },
    };
    normalizeThinking(transformed, model, config);
    normalizeTools(transformed, config.strict_tool_schema === true);
    if (
        !isImageGenerationModel(model) &&
        (config.system_instruction === true ||
            model.toLowerCase().includes("claude") ||
            model.toLowerCase().split("/").pop()?.startsWith("gemini-3"))
    ) {
        const existing = object(transformed.systemInstruction) ?? {};
        transformed.systemInstruction = {
            ...existing,
            role: "user",
            parts: [
                { text: BASE_SYSTEM_INSTRUCTION },
                ...array(existing.parts),
            ],
        };
    }
    normalizeContents(transformed, model, sessionId, config);
    transformed.sessionId = sessionId;
    return transformed;
}

export function stableNumericSessionId(payload: RequestPayload): string {
    const supplied = text(payload._sessionId).trim();
    if (/^-?\d+$/.test(supplied)) return supplied;
    const firstUser = array(payload.messages)
        .map(object)
        .find((message) => message?.role === "user");
    const seed =
        supplied ||
        (typeof firstUser?.content === "string"
            ? firstUser.content
            : JSON.stringify(firstUser?.content ?? randomUUID()));
    const digest = createHash("sha256").update(seed).digest();
    return `-${digest.readBigUInt64BE(0) & 0x7fffffffffffffffn}`;
}
