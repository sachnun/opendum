import { createCipheriv, createHash, createSign, publicEncrypt, randomBytes, constants } from "node:crypto";
import type { Registry } from "../registry/index.js";
import { jsonResponse, sseResponse, stringValue, readAllText, randomID, numberFromAny } from "./http.js";
import { parseSSEDataLines, randomUUID } from "./model_helpers.js";
import { responsesJSONToChatCompletion } from "./responses_transform.js";
import type { HttpClient, Provider, ProviderAccountLike, RefreshedCredentials, RequestContext, UpstreamResponse } from "./types.js";
import { markUpstreamResponseStarted } from "./latency.js";

const qoderOpenAPIBase = "https://openapi.qoder.sh";
const qoderInferenceBase = "https://api3.qoder.sh";
const qoderInferencePath = "/algo/api/v2/service/pro/sse/agent_chat_generation";
const qoderInferenceQuery = "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
const qoderDeviceRefreshPath = "/api/v1/deviceToken/refresh";
const qoderJobRefreshPath = "/api/v1/jobToken/refresh";
const qoderUserInfoPath = "/api/v1/userinfo";
const qoderPATRefreshPrefix = "jrt-";
const qoderIDEVersion = "1.0.0";
const qoderClientType = "5";
const qoderMachineType = "5";
const qoderMachineOS = "x86_64_windows";
const qoderDataPolicy = "disagree";
const qoderLoginVersion = "v2";
const qoderDefaultModel = "qmodel_latest";
const qoderRefreshBuffer = 5 * 60 * 1000;
const qoderSessionType = "qodercli";
const qoderAgentID = "agent_common";
const qoderTaskID = "common";

const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

const qoderRSAPublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export class QoderProvider implements Provider {
  constructor(private registry: Registry | null) {}

  refreshBuffer(): number {
    return qoderRefreshBuffer;
  }

  async refreshCredentials(ctx: RequestContext, client: HttpClient, refreshToken: string, _account: ProviderAccountLike): Promise<RefreshedCredentials> {
    refreshToken = refreshToken.trim();
    const path = refreshToken.startsWith(qoderPATRefreshPrefix) ? qoderJobRefreshPath : qoderDeviceRefreshPath;
    const resp = await client.fetch(qoderOpenAPIBase + path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) {
      const body = await readAllText(resp.body);
      throw new Error(`qoder token refresh failed: ${resp.status} ${body}`);
    }
    const token = (await readAllJSONSafe(resp.body)) as Record<string, unknown>;
    let accessToken = stringValue(token["device_token"]);
    if (accessToken === "") accessToken = stringValue(token["token"]);
    if (accessToken === "") {
      throw new Error("qoder token refresh returned empty token");
    }
    let newRefreshToken = stringValue(token["refresh_token"]);
    if (newRefreshToken === "") newRefreshToken = refreshToken;
    const expiresAt = parseQoderExpiry(stringValue(token["expires_at"]), numberFromAny(token["expires_in"]), 86400);
    return { accessToken, refreshToken: newRefreshToken, expiresAt, projectId: "", tier: "", email: "", accountId: "", storeAccessToken: "" };
  }

  async makeRequest(client: HttpClient, ctx: RequestContext, accessToken: string, account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    let [uid, machineID] = splitQoderAccountID(account.accountId);
    if (uid === "") {
      const resolved = await fetchQoderUserID(client, ctx, accessToken);
      uid = resolved;
    }
    if (machineID === "") machineID = uid;

    const modelName = this.resolveModel(stringValue(body["model"]));
    const isReasoning = this.registry !== null && this.registry.isReasoningModel(stringValue(body["model"]));

    const messages = (body["messages"] ?? []) as unknown[];
    const [systemText, normalizedMessages, lastUserText] = qoderTransformMessages(messages);
    let lastUser = lastUserText;
    if (lastUser === "") lastUser = "ping";

    const modelConfig: Record<string, unknown> = { key: modelName, is_reasoning: isReasoning, max_output_tokens: 32768, source: "system" };
    const recordID = randomQoderID();
    const sessionID = randomQoderID();
    const maxTokens = qoderMaxTokens(body);

    const reqBody: Record<string, unknown> = {
      request_id: randomQoderID(),
      request_set_id: recordID,
      chat_record_id: recordID,
      session_id: sessionID,
      stream: true,
      chat_task: "FREE_INPUT",
      is_reply: true,
      is_retry: false,
      source: 1,
      version: "3",
      session_type: qoderSessionType,
      agent_id: qoderAgentID,
      task_id: qoderTaskID,
      code_language: "",
      chat_prompt: "",
      image_urls: null,
      aliyun_user_type: "",
      system: systemText,
      messages: normalizedMessages,
      tools: qoderTools(body),
      parameters: { max_tokens: maxTokens },
      chat_context: {
        chatPrompt: "",
        imageUrls: null,
        extra: { context: [], modelConfig: { key: modelName, is_reasoning: isReasoning }, originalContent: lastUser },
        features: [],
        text: lastUser,
      },
      model_config: modelConfig,
      business: {
        product: "cli",
        version: qoderIDEVersion,
        type: "agent",
        stage: "start",
        id: randomQoderID(),
        name: qoderTruncate(lastUser, 30),
        begin_at: Date.now(),
      },
    };

    const plaintext = JSON.stringify(reqBody);
    const encoded = qoderEncodeBody(plaintext);
    const encodedBytes = Buffer.from(encoded, "utf8");
    const requestURL = qoderInferenceBase + qoderInferencePath + qoderInferenceQuery;
    const headers = buildQoderAuthHeaders(encodedBytes, requestURL, uid, machineID, accessToken);

    const resp = await client.fetch(requestURL, {
      method: "POST",
      headers,
      body: encodedBytes,
      signal: ctx.signal,
    });
    if (resp.status < 200 || resp.status >= 300) return resp;
    if (typeof (ctx as { recordResponseStart?: unknown }).recordResponseStart === "function") markUpstreamResponseStarted(ctx as never);

    if (stream) {
      return sseResponse(qoderSSEToChatSSE(resp.body, modelName));
    }
    const completion = await qoderStreamToCompletion(resp.body, modelName);
    return jsonResponse(200, completion);
  }

  resolveModel(model: string): string {
    model = lastModelSegment(model);
    if (this.registry) return this.registry.upstreamModelName(model, "qoder");
    if (model === "") return qoderDefaultModel;
    return model;
  }
}

export function qoderTransformMessages(messages: unknown[]): [string, unknown[], string] {
  const normalized: unknown[] = [];
  let systemText = "";
  let lastUserText = "";
  for (const raw of messages) {
    const msg = (raw ?? {}) as Record<string, unknown>;
    const role = stringValue(msg["role"]);
    const content = qoderMessageContent(msg["content"]);
    switch (role) {
      case "system":
        if (systemText === "") systemText = content;
        continue;
      case "user":
      case "assistant":
        normalized.push({ role, content });
        if (role === "user") lastUserText = content;
        break;
    }
  }
  if (lastUserText === "") {
    for (let i = normalized.length - 1; i >= 0; i--) {
      const msg = (normalized[i] ?? {}) as Record<string, unknown>;
      if (stringValue(msg["role"]) === "user") {
        lastUserText = stringValue(msg["content"]);
        break;
      }
    }
  }
  return [systemText, normalized, lastUserText];
}

function qoderMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    let out = "";
    for (const part of value) {
      const m = (part ?? {}) as Record<string, unknown>;
      const t = stringValue(m["text"]);
      if (t !== "") {
        out += t;
        continue;
      }
      out += stringValue(m["content"]);
    }
    return out;
  }
  return "";
}

function qoderTools(body: Record<string, unknown>): unknown[] {
  const tools = body["tools"];
  return Array.isArray(tools) ? tools : [];
}

function qoderMaxTokens(body: Record<string, unknown>): number {
  const v = numberFromAny(body["max_tokens"]);
  if (v > 0) return v;
  const v2 = numberFromAny(body["max_completion_tokens"]);
  if (v2 > 0) return v2;
  return 32768;
}

function qoderTruncate(value: string, limit: number): string {
  const runes = [...value];
  if (runes.length <= limit) return value;
  return runes.slice(0, limit).join("");
}

function buildQoderAuthHeaders(body: Buffer, requestURL: string, uid: string, machineID: string, authToken: string): Record<string, string> {
  const aesKey = randomQoderAESKey();
  const infoB64 = qoderAESEncryptCBC(JSON.stringify({ uid, security_oauth_token: authToken, name: "", aid: "", email: "" }), aesKey);
  const cosyKey = qoderRSAEncrypt(aesKey);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestID = randomQoderID();

  const cosyPayload = JSON.stringify({ version: "v1", requestId: requestID, info: infoB64, cosyVersion: qoderIDEVersion, ideVersion: "" });
  const payloadB64 = Buffer.from(cosyPayload, "utf8").toString("base64");

  const sigPath = qoderSigPath(requestURL);
  const bodyStr = body.toString("utf8");
  const sigInput = payloadB64 + "\n" + cosyKey + "\n" + timestamp + "\n" + bodyStr + "\n" + sigPath;
  const sig = qoderMD5Hex(sigInput);
  const bodyHash = qoderMD5Hex(bodyStr);

  return {
    authorization: "Bearer COSY." + payloadB64 + "." + sig,
    "cosy-key": cosyKey,
    "cosy-user": uid,
    "cosy-date": timestamp,
    "cosy-version": qoderIDEVersion,
    "cosy-machineid": machineID,
    "cosy-machinetoken": machineID,
    "cosy-machinetype": qoderMachineType,
    "cosy-machineos": qoderMachineOS,
    "cosy-clienttype": qoderClientType,
    "cosy-clientip": "127.0.0.1",
    "cosy-bodyhash": bodyHash,
    "cosy-bodylength": String(body.length),
    "cosy-sigpath": sigPath,
    "cosy-data-policy": qoderDataPolicy,
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "login-version": qoderLoginVersion,
    "x-request-id": randomQoderID(),
    "content-type": "application/json",
    accept: "text/event-stream",
  };
}

function qoderSigPath(requestURL: string): string {
  let path = requestURL;
  const schemeIdx = requestURL.indexOf("://");
  if (schemeIdx >= 0) {
    path = requestURL.slice(schemeIdx + 3);
    const slash = path.indexOf("/");
    if (slash >= 0) path = path.slice(slash);
  }
  const queryIdx = path.indexOf("?");
  if (queryIdx >= 0) path = path.slice(0, queryIdx);
  return path.replace(/^\/algo/, "");
}

function qoderAESEncryptCBC(plaintext: string, keyStr: string): string {
  const key = Buffer.from(keyStr, "utf8");
  const cipher = createCipheriv("aes-128-cbc", key, key);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const paddedLen = Math.ceil(plaintext.length / 16) * 16;
  return encrypted.subarray(0, paddedLen).toString("base64");
}

function qoderRSAEncrypt(data: string): string {
  try {
    const encrypted = publicEncrypt(
      { key: qoderRSAPublicKeyPEM, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(data, "utf8"),
    );
    return encrypted.toString("base64");
  } catch {
    return "";
  }
}

function qoderMD5Hex(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

export function qoderEncodeBody(plaintext: string): string {
  const std = Buffer.from(plaintext, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  const table = new Map<string, string>();
  for (let i = 0; i < qoderStdAlphabet.length; i++) {
    table.set(qoderStdAlphabet[i]!, qoderCustomAlphabet[i]!);
  }
  let out = "";
  for (const c of rearranged) {
    if (c === "=") {
      out += "$";
      continue;
    }
    out += table.get(c) ?? c;
  }
  return out;
}

export async function* qoderSSEToChatSSE(body: ReadableStream<Uint8Array> | null, model: string): AsyncGenerator<string> {
  const reader = body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "" || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      const inner = qoderExtractBody(payload);
      if (inner === "") continue;
      yield "data: " + inner + "\n\n";
    }
  }
  yield "data: [DONE]\n\n";
}

export function qoderExtractBody(payload: string): string {
  try {
    const envelope = JSON.parse(payload) as { body?: unknown; statusCode?: unknown };
    if (envelope.statusCode !== undefined && envelope.body === undefined) return "";
    if (envelope.body === undefined) return "";
    if (typeof envelope.body === "string") return envelope.body;
    return JSON.stringify(envelope.body);
  } catch {
    return payload;
  }
}

export async function qoderStreamToCompletion(body: ReadableStream<Uint8Array> | null, model: string): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of qoderSSEToChatSSE(body, model)) {
    data += chunk;
  }
  const events = parseSSEDataLines(data);
  const completion: Record<string, unknown> = { output: [], usage: {} };
  let messageContent = "";
  const toolCalls: unknown[] = [];
  let currentTool: Record<string, unknown> | null = null;
  for (const event of events) {
    const typ = stringValue(event["type"]);
    if (typ === "") {
      const choices = (event["choices"] ?? []) as unknown[];
      if (choices.length > 0) {
        const choice = (choices[0] ?? {}) as Record<string, unknown>;
        const delta = (choice["delta"] ?? {}) as Record<string, unknown>;
        if (delta) {
          const c = stringValue(delta["content"]);
          if (c !== "") messageContent += c;
          const rc = stringValue(delta["reasoning_content"]);
          if (rc !== "") messageContent += rc;
          const tc = delta["tool_calls"];
          if (Array.isArray(tc)) toolCalls.push(...tc);
        }
        const msg = (choice["message"] ?? {}) as Record<string, unknown>;
        if (msg) {
          const c = stringValue(msg["content"]);
          if (c !== "") messageContent += c;
        }
      }
    }
    switch (typ) {
      case "response.output_item.added": {
        const item = (event["item"] ?? {}) as Record<string, unknown>;
        if (item["type"] === "function_call") {
          currentTool = { type: "function_call", id: item["id"], call_id: item["call_id"], name: item["name"], arguments: "" };
        }
        break;
      }
      case "response.function_call_arguments.delta":
        if (currentTool) {
          currentTool["arguments"] = stringValue(currentTool["arguments"]) + stringValue(event["delta"]);
        }
        break;
      case "response.function_call_arguments.done":
      case "response.output_item.done":
        if (currentTool) {
          toolCalls.push(currentTool);
          currentTool = null;
        }
        break;
      case "response.completed":
      case "response.done": {
        const resp = (event["response"] ?? event) as Record<string, unknown>;
        completion["status"] = resp["status"];
        completion["usage"] = resp["usage"];
        break;
      }
    }
  }
  const output: unknown[] = [];
  if (messageContent !== "") {
    output.push({ type: "message", content: [{ type: "output_text", text: messageContent }] });
  }
  output.push(...toolCalls);
  completion["output"] = output;
  return responsesJSONToChatCompletion(completion, model);
}

async function fetchQoderUserID(client: HttpClient, ctx: RequestContext, accessToken: string): Promise<string> {
  const resp = await client.fetch(qoderOpenAPIBase + qoderUserInfoPath, {
    method: "GET",
    headers: { authorization: "Bearer " + accessToken.trim(), accept: "application/json" },
    signal: ctx.signal,
  });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`qoder userinfo failed: ${resp.status}`);
  }
  const user = (await readAllJSONSafe(resp.body)) as { id?: unknown };
  return stringValue(user["id"]);
}

export function splitQoderAccountID(accountID: string | null): [string, string] {
  if (accountID === null) return ["", ""];
  const value = accountID.trim();
  if (value === "") return ["", ""];
  const idx = value.indexOf("|");
  if (idx >= 0) return [value.slice(0, idx), value.slice(idx + 1)];
  return [value, value];
}

function parseQoderExpiry(expiresAt: string, expiresInSeconds: number, fallbackSeconds: number): Date {
  if (expiresAt !== "") {
    const parsed = new Date(expiresAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (expiresInSeconds > 0) return new Date(Date.now() + expiresInSeconds * 1000);
  return new Date(Date.now() + fallbackSeconds * 1000);
}

function randomQoderID(): string {
  const buf = randomBytes(16);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomQoderAESKey(): string {
  return randomQoderID().replace(/-/g, "").slice(0, 16);
}

function lastModelSegment(model: string): string {
  const idx = model.lastIndexOf("/");
  return idx >= 0 ? model.slice(idx + 1) : model;
}

async function readAllJSONSafe(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  const text = await readAllText(body);
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
