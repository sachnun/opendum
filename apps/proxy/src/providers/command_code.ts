import type { Registry } from "../registry/index.js";
import { jsonResponse, sseResponse, stringValue, defaultStringValue, numberFromAny, randomID, iterateLines } from "./http.js";
import { contentToText } from "./responses_transform.js";
import type { HttpClient, Provider, ProviderAccountLike, RequestContext, UpstreamResponse } from "./types.js";
import { markUpstreamResponseStarted } from "./latency.js";

const commandCodeBaseURL = "https://api.commandcode.ai";
const commandCodeGenerate = "/alpha/generate";
const commandCodeVersion = "0.38.7";
const commandCodeEnv = "production";
const commandCodeProject = "command-code";
const commandCodePlatform = "linux-x64";
const commandCodeMaxTokens = 16384;

export class CommandCodeProvider implements Provider {
  constructor(private registry: Registry | null) {}

  async makeRequest(client: HttpClient, ctx: RequestContext, credentials: string, _account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    let model = stringValue(body["model"]);
    if (model.startsWith("command_code/")) {
      model = model.slice("command_code/".length);
    }
    if (this.registry) {
      model = this.registry.upstreamModelName(model, "command_code");
    }

    const includeReasoning = isTruthful(body["_includeReasoning"]);
    const envelope = buildCommandCodeEnvelope(body, model);

    const resp = await client.fetch(commandCodeBaseURL + commandCodeGenerate, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + credentials.trim(),
        accept: "text/event-stream",
        "x-command-code-version": commandCodeVersion,
        "x-cli-environment": commandCodeEnv,
        "x-project-slug": commandCodeProject,
      },
      body: JSON.stringify(envelope),
      signal: ctx.signal,
    });
    if (typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);

    if (resp.status < 200 || resp.status >= 300) return resp;

    if (stream) {
      return sseResponse(commandCodeSSEToChatSSE(resp.body, model, includeReasoning));
    }
    const completion = await commandCodeSSEToChatCompletion(resp.body, model, includeReasoning);
    return jsonResponse(200, completion);
  }
}

function isTruthful(value: unknown): boolean {
  return typeof value === "boolean" && value;
}

export function buildCommandCodeEnvelope(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const [system, messages] = commandCodeMessages(body["messages"]);
  const tools = commandCodeTools(body["tools"]);

  let maxTokens = numberFromAny(body["max_tokens"]);
  if (maxTokens === 0) maxTokens = numberFromAny(body["max_completion_tokens"]);
  if (maxTokens === 0) maxTokens = commandCodeMaxTokens;

  const params: Record<string, unknown> = { model, messages, stream: true, max_tokens: maxTokens };
  if (tools.length > 0) params["tools"] = tools;
  if (system !== "") params["system"] = system;
  if (body["temperature"] !== undefined && body["temperature"] !== null) params["temperature"] = body["temperature"];
  if (body["top_p"] !== undefined && body["top_p"] !== null) params["top_p"] = body["top_p"];

  return {
    config: {
      workingDir: "/",
      date: new Date().toISOString().slice(0, 10),
      environment: commandCodePlatform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: "",
    skills: null,
    permissionMode: "standard",
    params,
  };
}

export function commandCodeMessages(raw: unknown): [string, unknown[]] {
  const source = Array.isArray(raw) ? raw : [];
  const toolNamesByID = new Map<string, string>();
  for (const item of source) {
    const msg = (item ?? {}) as Record<string, unknown>;
    const calls = msg["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const rawCall of calls) {
      const call = (rawCall ?? {}) as Record<string, unknown>;
      const fn = (call["function"] ?? {}) as Record<string, unknown>;
      const name = stringValue(fn["name"]);
      const id = stringValue(call["id"]);
      if (name !== "" && id !== "") toolNamesByID.set(id, name);
    }
  }

  const systemParts: string[] = [];
  const out: unknown[] = [];
  for (const item of source) {
    const msg = (item ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    switch (role) {
      case "system":
      case "developer": {
        const text = contentToText(msg["content"]).trim();
        if (text !== "") systemParts.push(text);
        break;
      }
      case "user":
        out.push({ role: "user", content: contentToText(msg["content"]) });
        break;
      case "assistant":
        out.push({ role: "assistant", content: commandCodeAssistantParts(msg) });
        break;
      case "tool": {
        const id = stringValue(msg["tool_call_id"]);
        out.push({
          role: "tool",
          content: [{ type: "tool-result", toolCallId: id, toolName: toolNamesByID.get(id) ?? "", output: { type: "text", value: contentToText(msg["content"]) } }],
        });
        break;
      }
      default:
        out.push({ role: defaultEmpty(role, "user"), content: contentToText(msg["content"]) });
        break;
    }
  }
  return [systemParts.join("\n\n"), out];
}

function commandCodeAssistantParts(msg: Record<string, unknown>): unknown[] {
  const parts: unknown[] = [];
  const text = contentToText(msg["content"]);
  if (text !== "") parts.push({ type: "text", text });
  const calls = msg["tool_calls"];
  if (Array.isArray(calls)) {
    for (const rawCall of calls) {
      const call = (rawCall ?? {}) as Record<string, unknown>;
      const fn = (call["function"] ?? {}) as Record<string, unknown>;
      const name = stringValue(fn["name"]);
      if (name === "") continue;
      parts.push({ type: "tool-call", toolCallId: stringValue(call["id"]), toolName: name, input: defaultStringValue(fn["arguments"], "{}") });
    }
  }
  return parts;
}

function commandCodeTools(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const item of raw) {
    let tool = (item ?? {}) as Record<string, unknown>;
    let fn = (tool["function"] ?? {}) as Record<string, unknown>;
    if (!fn) fn = tool;
    let name = stringValue(fn["name"]);
    if (name === "") name = stringValue(tool["name"]);
    if (name === "") continue;
    let params = fn["parameters"];
    if (typeof params !== "object" || params === null) {
      params = { type: "object", properties: {} };
    }
    const entry: Record<string, unknown> = { type: "function", name, description: defaultStringValue(fn["description"], ""), input_schema: params };
    if (typeof fn["strict"] === "boolean") entry["strict"] = fn["strict"];
    out.push(entry);
  }
  return out;
}

interface CCToolState {
  index: number;
  name: string;
  opened: boolean;
}

export async function* commandCodeSSEToChatSSE(source: ReadableStream<Uint8Array> | null, model: string, includeReasoning: boolean): AsyncGenerator<string> {
  const completionID = randomID("chatcmpl");
  let sentRole = false;
  let nextToolIndex = 0;
  const tools = new Map<string, CCToolState>();

  const writeChunk = (delta: Record<string, unknown>, finish: unknown, usage: Record<string, unknown> | null): string => {
    const chunk: Record<string, unknown> = { id: completionID, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
    if (usage) chunk["usage"] = usage;
    return "data: " + JSON.stringify(chunk) + "\n\n";
  };
  const ensureRole = (): string => {
    if (!sentRole) {
      sentRole = true;
      return writeChunk({ role: "assistant", content: "" }, null, null);
    }
    return "";
  };
  const emitToolCall = (state: CCToolState, id: string, arguments_: string, withName: boolean): string => {
    const fn: Record<string, unknown> = {};
    if (withName) fn["name"] = state.name;
    if (arguments_ !== "") fn["arguments"] = arguments_;
    const delta: Record<string, unknown> = { tool_calls: [{ index: state.index, id, type: "function", function: fn }] };
    return writeChunk(delta, null, null);
  };

  for await (const line of iterateLines(source)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith(":")) continue;
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (payload === "" || payload === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const typ = stringValue(event["type"]);
    switch (typ) {
      case "text-delta": {
        ensureRole();
        const delta = commandCodeDeltaText(event);
        if (delta !== "") yield writeChunk({ content: delta }, null, null);
        break;
      }
      case "reasoning-delta": {
        if (includeReasoning) {
          ensureRole();
          const delta = commandCodeDeltaText(event);
          if (delta !== "") yield writeChunk({ reasoning_content: delta }, null, null);
        }
        break;
      }
      case "tool-input-start": {
        ensureRole();
        const id = stringValue(event["id"]);
        const name = stringValue(event["toolName"]);
        const state: CCToolState = { index: nextToolIndex, name, opened: true };
        tools.set(id, state);
        nextToolIndex++;
        yield emitToolCall(state, id, "", true);
        break;
      }
      case "tool-input-delta": {
        const id = stringValue(event["id"]);
        let state = tools.get(id);
        if (!state) {
          state = { index: nextToolIndex, opened: true, name: "" };
          tools.set(id, state);
          nextToolIndex++;
        }
        const delta = commandCodeDeltaText(event);
        if (delta !== "") yield emitToolCall(state, id, delta, false);
        break;
      }
      case "tool-call": {
        const id = defaultStringValue(event["toolCallId"], stringValue(event["id"]));
        const name = stringValue(event["toolName"]);
        const args = commandCodeToolInput(event);
        const existing = tools.get(id);
        if (existing && existing.opened) {
          existing.name = name;
          continue;
        }
        const state: CCToolState = { index: nextToolIndex, name, opened: true };
        tools.set(id, state);
        nextToolIndex++;
        yield emitToolCall(state, id, args, true);
        break;
      }
      case "finish":
      case "finish-step": {
        if (typ === "finish-step") continue;
        const finish = mapCCFinishReason(commandCodeFinishReason(event));
        const usage = ccUsageToChatUsage(event["usage"]) ?? {};
        yield writeChunk({}, finish, usage);
        break;
      }
      case "error": {
        ensureRole();
        const msg = commandCodeErrorMessage(event);
        if (msg !== "") yield writeChunk({ content: msg }, null, null);
        yield writeChunk({}, "stop", { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        break;
      }
    }
  }
  yield "data: [DONE]\n\n";
}

export async function commandCodeSSEToChatCompletion(source: ReadableStream<Uint8Array> | null, model: string, includeReasoning: boolean): Promise<Record<string, unknown>> {
  let content = "";
  let reasoning = "";
  const toolCalls: unknown[] = [];
  let finishReason = "stop";
  let usage: Record<string, unknown> | null = null;

  let nextToolIndex = 0;
  const tools = new Map<string, CCToolState>();
  const pendingArgs = new Map<string, string>();

  for await (const line of iterateLines(source)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "[DONE]" || trimmed.startsWith(":")) continue;
    const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
    if (payload === "" || payload === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const typ = stringValue(event["type"]);
    switch (typ) {
      case "text-delta": {
        const delta = commandCodeDeltaText(event);
        if (delta !== "") content += delta;
        break;
      }
      case "reasoning-delta": {
        if (includeReasoning) {
          const delta = commandCodeDeltaText(event);
          if (delta !== "") reasoning += delta;
        }
        break;
      }
      case "tool-input-start": {
        const id = stringValue(event["id"]);
        tools.set(id, { index: nextToolIndex, name: stringValue(event["toolName"]), opened: false });
        pendingArgs.set(id, "");
        nextToolIndex++;
        break;
      }
      case "tool-input-delta": {
        const id = stringValue(event["id"]);
        const current = pendingArgs.get(id);
        if (current !== undefined) {
          pendingArgs.set(id, current + commandCodeDeltaText(event));
        }
        break;
      }
      case "tool-call": {
        const id = defaultStringValue(event["toolCallId"], stringValue(event["id"]));
        const name = stringValue(event["toolName"]);
        let args = commandCodeToolInput(event);
        const buffered = pendingArgs.get(id);
        if (buffered !== undefined) args = buffered;
        if (!tools.has(id)) {
          tools.set(id, { index: nextToolIndex, name, opened: false });
          nextToolIndex++;
        }
        toolCalls.push({ id: toChatCallID(id), type: "function", function: { name, arguments: defaultStringValue(args, "{}") } });
        break;
      }
      case "error": {
        const msg = commandCodeErrorMessage(event);
        if (msg !== "") content += msg;
        break;
      }
      case "finish":
        finishReason = mapCCFinishReason(commandCodeFinishReason(event));
        usage = ccUsageToChatUsage(event["usage"]);
        break;
    }
  }

  const message: Record<string, unknown> = { role: "assistant", content: null };
  if (content !== "") message["content"] = content;
  if (includeReasoning && reasoning !== "") message["reasoning_content"] = reasoning;
  if (toolCalls.length > 0) {
    message["tool_calls"] = toolCalls;
    finishReason = "tool_calls";
  }
  if (usage === null) usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return { id: randomID("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finishReason }], usage };
}

function commandCodeDeltaText(event: Record<string, unknown>): string {
  const delta = stringValue(event["delta"]);
  if (delta !== "") return delta;
  return stringValue(event["text"]);
}

function commandCodeToolInput(event: Record<string, unknown>): string {
  for (const key of ["input", "args", "arguments"]) {
    const value = event[key];
    if (value !== undefined && value !== null) {
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }
  }
  return "";
}

function commandCodeFinishReason(event: Record<string, unknown>): string {
  for (const key of ["finishReason", "finish_reason"]) {
    const value = stringValue(event[key]);
    if (value !== "") return value;
  }
  return "stop";
}

function commandCodeErrorMessage(event: Record<string, unknown>): string {
  for (const key of ["error", "message"]) {
    const value = event[key];
    if (value !== undefined && value !== null) {
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    }
  }
  return "";
}

function mapCCFinishReason(raw: string): string {
  switch (raw) {
    case "stop":
    case "end_turn":
      return "stop";
    case "tool_calls":
    case "tool-calls":
      return "tool_calls";
    case "length":
    case "max_tokens":
    case "max-tokens":
    case "max_output_tokens":
      return "length";
    case "content_filter":
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}

function ccUsageToChatUsage(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const input = commandCodeUsageInt(usage, ["inputTokens", "prompt_tokens"]);
  const output = commandCodeUsageInt(usage, ["outputTokens", "completion_tokens"]);
  if (input === 0 && output === 0) return {};
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}

function commandCodeUsageInt(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = numberFromAny(usage[key]);
    if (value > 0) return value;
  }
  return 0;
}

function toChatCallID(id: string): string {
  if (id === "") return randomID("call");
  if (id.startsWith("call_")) return id;
  if (id.startsWith("fc_") || id.startsWith("fc-")) return "call_" + id.slice(3);
  return "call_" + id;
}

function defaultEmpty(value: string, fallback: string): string {
  return value === "" ? fallback : value;
}
