import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Chat } from "@opendum/api/core/endpoints";
import { listVisibleModels } from "@opendum/api/handlers/model-listing";
import { parseJsonObject, runOutcome } from "@opendum/api/mcp/run";
import { DATA_OUTPUT, JSON_RECORD, READ_ONLY, WRITE, isRecord, jsonResult, textError, type ToolEnv } from "@opendum/api/mcp/tools/shared";

const DEFAULT_MODEL_LIMIT = 50;
const MAX_MODEL_LIMIT = 200;

const CHAT_MESSAGE = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(JSON_RECORD)]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(JSON_RECORD).optional(),
});

const CHAT_OUTPUT = z.object({
  id: z.string().nullable(),
  model: z.string().nullable(),
  usage: JSON_RECORD.nullable(),
  message: JSON_RECORD.nullable(),
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function errorMessageOf(payload: Record<string, unknown>): string {
  const error = payload.error;
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message;
  return "unknown error";
}

function assistantTextOf(message: Record<string, unknown>): string {
  const parts: string[] = [];
  const content = message.content;
  if (typeof content === "string") {
    if (content.trim()) parts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        parts.push(part.text);
      }
    }
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const callPart of toolCalls) {
    if (isRecord(callPart) && isRecord(callPart.function) && typeof callPart.function.name === "string") {
      parts.push(`Tool call requested: ${callPart.function.name}`);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : "(empty assistant message)";
}

async function chatResult(response: Response): Promise<CallToolResult> {
  const payload = parseJsonObject(await response.text());
  if (!response.ok) {
    return textError(`opendum chat request failed with status ${response.status}: ${errorMessageOf(payload)}`);
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
  return {
    content: [{ type: "text", text: assistantTextOf(message) }],
    structuredContent: {
      id: stringOrNull(payload.id),
      model: stringOrNull(payload.model),
      usage: isRecord(payload.usage) ? payload.usage : null,
      message,
    },
  };
}

type ChatArgs = {
  model: string;
  messages: Array<z.infer<typeof CHAT_MESSAGE>>;
  system?: string;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  params?: Record<string, unknown>;
};

async function chatTool(env: ToolEnv, args: ChatArgs): Promise<CallToolResult> {
  const payload: Record<string, unknown> = { ...args.params };
  payload.model = args.model;
  payload.messages = args.system ? [{ role: "system", content: args.system }, ...args.messages] : [...args.messages];
  payload.stream = false;
  if (args.temperature !== undefined) payload.temperature = args.temperature;
  if (args.max_tokens !== undefined) payload.max_tokens = args.max_tokens;
  if (args.tools !== undefined) payload.tools = args.tools;
  if (args.tool_choice !== undefined) payload.tool_choice = args.tool_choice;

  const outcome = await runOutcome(
    Effect.flatMap(
      Effect.tryPromise({
        try: () => env.context.service.handle(new Chat(), payload, env.authHeader, randomUUID()),
        catch: (cause) => cause,
      }),
      (response) => Effect.promise(() => chatResult(response))
    ),
    "run chat completion"
  );
  if (!outcome.ok) return textError(outcome.message);
  return outcome.value;
}

export function registerGatewayTools(server: McpServer, env: ToolEnv): void {
  server.registerTool(
    "gateway_health_read",
    {
      title: "Gateway health",
      description:
        "Read gateway health. Checks whether the opendum gateway is serving requests.\n\nUse when: check whether opendum is reachable.\nRisk: read. HTTP: GET /health.",
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: READ_ONLY,
    },
    async () => ({ content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } })
  );

  server.registerTool(
    "models_list",
    {
      title: "List models",
      description:
        "List LLM models available to the connected opendum key, already filtered by the key's access policy and account availability.\n\nUse when: discover which model ids the key can call; pick a model for chat_create.\nRisk: read. HTTP: GET /v1/models.",
      inputSchema: z.object({
        query: z.string().optional().describe("Substring filter on the model id"),
        limit: z.number().int().min(1).max(MAX_MODEL_LIMIT).optional(),
      }),
      outputSchema: z.object({ total: z.number(), models: z.array(JSON_RECORD) }),
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const outcome = await runOutcome(listVisibleModels(env.context, env.identity), "list models");
      if (!outcome.ok) return textError(outcome.message);
      const needle = (query ?? "").toLowerCase();
      const filtered = needle
        ? outcome.value.filter((item) => typeof item.id === "string" && item.id.toLowerCase().includes(needle))
        : outcome.value;
      const models = filtered.slice(0, limit ?? DEFAULT_MODEL_LIMIT);
      return {
        content: [{ type: "text", text: JSON.stringify(models, null, 2) }],
        structuredContent: { total: models.length, models },
      };
    }
  );

  server.registerTool(
    "models_read",
    {
      title: "Model details",
      description:
        "Read one model: serving providers, context limit, modalities, reasoning and vision support, cost. Resolves aliases.\n\nUse when: inspect a model id from models_list before calling it.\nNote: Use model ids exactly as returned by models_list.\nRisk: read.",
      inputSchema: z.object({ model: z.string().min(1) }),
      outputSchema: JSON_RECORD,
      annotations: READ_ONLY,
    },
    async ({ model }) => {
      const canonical = env.context.models.resolveAlias(model);
      const item = env.context.models.openAiModels().find((candidate) => candidate.id === canonical);
      if (!item) {
        return textError(`Unknown model "${model}". Use models_list to see available models.`);
      }
      const info: Record<string, unknown> = { ...item, requested: model, id: canonical };
      const family = env.context.models.modelFamily(canonical);
      if (family) info.family = family;
      const cost = env.context.models.modelCost(canonical);
      if (cost) info.cost = cost;
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }], structuredContent: info };
    }
  );

  server.registerTool(
    "models_cost_estimate",
    {
      title: "Estimate model cost",
      description:
        "Estimate the point cost of one model call from token counts, using the same cost table opendum charges with.\n\nUse when: compare model pricing; budget a chat_create call before spending points.\nNote: Estimates only local cost math; actual billing also applies the request pipeline.\nRisk: read.",
      inputSchema: z.object({
        model: z.string().min(1),
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        cachedTokens: z.number().int().min(0).optional(),
        cacheWriteTokens: z.number().int().min(0).optional(),
      }),
      outputSchema: DATA_OUTPUT,
      annotations: READ_ONLY,
    },
    async (args) => {
      const canonical = env.context.models.resolveAlias(args.model);
      const cost = env.context.models.modelCost(canonical);
      if (!cost) return textError(`No cost information for model "${args.model}".`);
      const inputTokens = args.inputTokens ?? 0;
      const outputTokens = args.outputTokens ?? 0;
      const cachedTokens = args.cachedTokens ?? 0;
      const cacheWriteTokens = args.cacheWriteTokens ?? 0;
      const rawPoints =
        (inputTokens * (cost.input ?? 0) +
          outputTokens * (cost.output ?? 0) +
          cachedTokens * (cost.cacheRead ?? 0) +
          cacheWriteTokens * (cost.cacheWrite ?? 0)) /
        1_000_000;
      const estimate = {
        model: canonical,
        ratesPerMillionTokens: cost,
        inputTokens,
        outputTokens,
        cachedTokens,
        cacheWriteTokens,
        rawPoints,
        estimatedPoints: Math.max(1, Math.ceil(rawPoints)),
      };
      return jsonResult(estimate);
    }
  );

  server.registerTool(
    "chat_create",
    {
      title: "Chat completion",
      description:
        "Create one chat completion through opendum and get the assistant reply. Messages follow the OpenAI chat completions format.\n\nUse when: ask a model a question; run an agentic loop step. Pass tools to let the model request tool calls.\nNote: Spends points from the connected key's owner. Use models_list to pick a model first.\nRisk: write. HTTP: POST /v1/chat/completions.",
      inputSchema: z.object({
        model: z.string().min(1).describe("Model id from models_list"),
        messages: z.array(CHAT_MESSAGE).min(1),
        system: z.string().optional().describe("Prepended as a system message"),
        temperature: z.number().min(0).max(2).optional(),
        max_tokens: z.number().int().min(1).optional(),
        tools: z.array(JSON_RECORD).optional().describe("OpenAI function tool definitions"),
        tool_choice: z.union([z.string(), JSON_RECORD]).optional(),
        params: JSON_RECORD.optional().describe("Extra OpenAI-compatible request parameters"),
      }),
      outputSchema: CHAT_OUTPUT,
      annotations: WRITE,
    },
    (args) => chatTool(env, args)
  );
}
