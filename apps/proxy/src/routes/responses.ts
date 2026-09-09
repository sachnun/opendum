import { Hono } from "hono";
import type { ModelRegistry, ProviderRegistry } from "@opendum/ai";
import {
    chatCompletionToResponsesJSON,
    chatSSEToResponsesSSE,
    responsesInputToMessages,
} from "@opendum/ai";
import type { AuthService } from "../auth/service.js";
import { LoadBalancer } from "../proxy/balancer.js";
import { SessionAffinity } from "../proxy/affinity.js";
import { writeOpenAIError } from "../errors.js";
import { createChatRoute } from "./chat.js";

function responsesToolsToChat(tools: any[]): any[] {
    const converted: any[] = [];

    for (const tool of tools) {
        if (!tool || typeof tool !== "object") continue;
        if (tool.type === "namespace") {
            const namespace = typeof tool.name === "string" ? tool.name : "";
            if (!Array.isArray(tool.tools)) continue;
            for (const child of tool.tools) {
                if (!child || typeof child !== "object") continue;
                const fn = { ...child };
                delete fn.type;
                if (typeof fn.name === "string")
                    fn.name = `${namespace}${fn.name}`;
                converted.push({ type: "function", function: fn });
            }
        } else if (tool.type === "function") {
            if (tool.function && typeof tool.function === "object") {
                converted.push(tool);
            } else {
                const fn = { ...tool };
                delete fn.type;
                converted.push({ type: "function", function: fn });
            }
        }
    }

    return converted;
}

function responsesToolChoiceToChat(toolChoice: unknown): unknown {
    if (
        !toolChoice ||
        typeof toolChoice !== "object" ||
        Array.isArray(toolChoice)
    ) {
        return toolChoice;
    }
    const choice = toolChoice as any;
    if (
        choice.type === "function" &&
        typeof choice.name === "string" &&
        !choice.function
    ) {
        return { type: "function", function: { name: choice.name } };
    }
    return toolChoice;
}

function convertResponsesToOpenAI(body: any): Record<string, unknown> {
    const messages: any[] = [];
    if (typeof body.instructions === "string" && body.instructions) {
        messages.push({ role: "system", content: body.instructions });
    }
    messages.push(...responsesInputToMessages(body.input));

    const converted: Record<string, unknown> = {
        model: body.model,
        messages,
        stream: Boolean(body.stream),
        _responsesInput: body.input,
        _includeReasoning:
            body.reasoning != null || body.reasoning_effort != null,
    };

    const passthroughFields = [
        "temperature",
        "top_p",
        "parallel_tool_calls",
        "presence_penalty",
        "frequency_penalty",
        "stop",
        "seed",
        "service_tier",
        "prompt_cache_key",
        "reasoning",
        "reasoning_effort",
        "user",
    ] as const;
    for (const field of passthroughFields) {
        if (body[field] !== undefined) converted[field] = body[field];
    }

    if (body.max_output_tokens !== undefined) {
        converted.max_tokens = body.max_output_tokens;
    } else if (body.max_tokens !== undefined) {
        converted.max_tokens = body.max_tokens;
    }
    if (Array.isArray(body.tools))
        converted.tools = responsesToolsToChat(body.tools);
    if (body.tool_choice !== undefined) {
        converted.tool_choice = responsesToolChoiceToChat(body.tool_choice);
    }
    if (body.response_format !== undefined) {
        converted.response_format = body.response_format;
    } else if (body.text?.format !== undefined) {
        converted.response_format = body.text.format;
    }
    if (body.stream) converted.stream_options = { include_usage: true };
    if (typeof body.instructions === "string" && body.instructions) {
        converted.instructions = body.instructions;
    }

    return converted;
}

function delegatedAuthService(authService: AuthService): AuthService {
    const delegated = Object.create(authService) as AuthService;
    delegated.validatePlaygroundAuth = (user, timestamp, signature, method) =>
        authService.validatePlaygroundAuth(
            user,
            timestamp,
            signature,
            method,
            "/v1/responses",
        );
    return delegated;
}

function responseHeaders(source: Headers, contentType?: string): Headers {
    const headers = new Headers(source);
    headers.delete("content-length");
    if (contentType) headers.set("content-type", contentType);
    return headers;
}

export function createResponsesRoute(
    authService: AuthService,
    registry: ModelRegistry,
    providers: ProviderRegistry,
    loadBalancer: LoadBalancer,
    affinity?: SessionAffinity,
) {
    const router = new Hono();
    const chatRouter = createChatRoute(
        delegatedAuthService(authService),
        registry,
        providers,
        loadBalancer,
        affinity,
    );

    router.post("/v1/responses", async (c) => {
        let responsesBody: any;
        try {
            responsesBody = await c.req.json();
        } catch {
            return writeOpenAIError(c, 400, {
                message: "Invalid JSON in request body",
                type: "invalid_request_error",
            });
        }

        if (
            !responsesBody ||
            typeof responsesBody !== "object" ||
            Array.isArray(responsesBody)
        ) {
            return writeOpenAIError(c, 400, {
                message: "Request body must be a JSON object",
                type: "invalid_request_error",
            });
        }
        if (!Array.isArray(responsesBody.input)) {
            return writeOpenAIError(c, 400, {
                message: "input array is required",
                type: "invalid_request_error",
            });
        }

        const openAIBody = convertResponsesToOpenAI(responsesBody);
        const delegatedURL = new URL(c.req.url);
        delegatedURL.pathname = "/v1/chat/completions";
        const delegatedRequest = new Request(delegatedURL, {
            method: "POST",
            headers: new Headers(c.req.raw.headers),
            body: JSON.stringify(openAIBody),
        });
        const delegatedResponse = await chatRouter.fetch(delegatedRequest);

        if (!delegatedResponse.ok) {
            return new Response(delegatedResponse.body, {
                status: delegatedResponse.status,
                statusText: delegatedResponse.statusText,
                headers: responseHeaders(delegatedResponse.headers),
            });
        }

        const model =
            typeof responsesBody.model === "string" ? responsesBody.model : "";
        if (responsesBody.stream) {
            if (!delegatedResponse.body) {
                return new Response(null, {
                    status: delegatedResponse.status,
                    headers: responseHeaders(
                        delegatedResponse.headers,
                        "text/event-stream",
                    ),
                });
            }
            return new Response(
                chatSSEToResponsesSSE(delegatedResponse.body, model),
                {
                    status: delegatedResponse.status,
                    headers: responseHeaders(
                        delegatedResponse.headers,
                        "text/event-stream",
                    ),
                },
            );
        }

        let chatCompletion: any;
        try {
            chatCompletion = await delegatedResponse.json();
        } catch {
            return writeOpenAIError(c, 502, {
                message:
                    "Invalid JSON response from delegated chat completion route.",
                type: "api_error",
            });
        }

        const responsesCompletion = chatCompletionToResponsesJSON(
            chatCompletion,
            model,
        );
        return new Response(JSON.stringify(responsesCompletion), {
            status: delegatedResponse.status,
            headers: responseHeaders(
                delegatedResponse.headers,
                "application/json; charset=UTF-8",
            ),
        });
    });

    return router;
}
