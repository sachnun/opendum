import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  publicEncrypt,
  randomUUID,
} from "node:crypto";
import {
  QODER_CLIENT_TYPE,
  QODER_CUSTOM_ALPHABET,
  QODER_DATA_POLICY,
  QODER_DEFAULT_MAX_TOKENS,
  QODER_IDE_VERSION,
  QODER_LOGIN_VERSION,
  QODER_MACHINE_OS,
  QODER_MACHINE_TYPE,
  QODER_RSA_PUBLIC_KEY,
  QODER_STANDARD_ALPHABET,
} from "./constants.js";

export interface QoderMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TransformedQoderMessages {
  system: string;
  messages: QoderMessage[];
  lastUserText: string;
}

type JsonRecord = Record<string, any>;

export function transformQoderMessages(value: unknown): TransformedQoderMessages {
  const messages: QoderMessage[] = [];
  let system = "";
  let lastUserText = "";

  if (!Array.isArray(value)) return { system, messages, lastUserText };

  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const role = typeof raw.role === "string" ? raw.role : "";
    const content = qoderMessageContent(raw.content);
    if (role === "system") {
      if (!system) system = content;
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role, content });
    if (role === "user") lastUserText = content;
  }

  return { system, messages, lastUserText };
}

export function qoderMaxTokens(body: Record<string, unknown>): number {
  const maxTokens = positiveNumber(body.max_tokens);
  if (maxTokens) return maxTokens;
  return positiveNumber(body.max_completion_tokens) || QODER_DEFAULT_MAX_TOKENS;
}

export function encodeQoderBody(plaintext: string): string {
  const standard = Buffer.from(plaintext, "utf8").toString("base64");
  const third = Math.floor(standard.length / 3);
  const rearranged =
    standard.slice(standard.length - third) +
    standard.slice(third, standard.length - third) +
    standard.slice(0, third);
  const substitutions = new Map(
    [...QODER_STANDARD_ALPHABET].map((character, index) => [
      character,
      QODER_CUSTOM_ALPHABET[index]!,
    ]),
  );

  return [...rearranged]
    .map((character) =>
      character === "=" ? "$" : (substitutions.get(character) ?? character),
    )
    .join("");
}

export function buildQoderAuthHeaders(
  body: string,
  requestUrl: string,
  uid: string,
  machineId: string,
  authToken: string,
): Record<string, string> {
  const aesKey = randomUUID().replaceAll("-", "").slice(0, 16);
  const info = JSON.stringify({
    uid,
    security_oauth_token: authToken,
    name: "",
    aid: "",
    email: "",
  });
  const infoBase64 = encryptAesCbc(info, aesKey);
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey, "utf8"),
  ).toString("base64");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadBase64 = Buffer.from(
    JSON.stringify({
      version: "v1",
      requestId: randomUUID(),
      info: infoBase64,
      cosyVersion: QODER_IDE_VERSION,
      ideVersion: "",
    }),
    "utf8",
  ).toString("base64");
  const sigPath = qoderSigPath(requestUrl);
  const signature = md5(
    `${payloadBase64}\n${cosyKey}\n${timestamp}\n${body}\n${sigPath}`,
  );

  return {
    Authorization: `Bearer COSY.${payloadBase64}.${signature}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": uid,
    "Cosy-Date": timestamp,
    "Cosy-Version": QODER_IDE_VERSION,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": QODER_MACHINE_TYPE,
    "Cosy-Machineos": QODER_MACHINE_OS,
    "Cosy-Clienttype": QODER_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5(body),
    "Cosy-Bodylength": Buffer.byteLength(body, "utf8").toString(),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": QODER_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": QODER_LOGIN_VERSION,
    "X-Request-Id": randomUUID(),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
}

export function qoderSigPath(requestUrl: string): string {
  const path = new URL(requestUrl).pathname;
  return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}

export function splitQoderAccountId(accountId: string | null | undefined): {
  uid: string;
  machineId: string;
} {
  const value = accountId?.trim() ?? "";
  if (!value) return { uid: "", machineId: "" };
  const separator = value.indexOf("|");
  if (separator < 0) return { uid: value, machineId: value };
  return {
    uid: value.slice(0, separator).trim(),
    machineId: value.slice(separator + 1).trim(),
  };
}

export function transformQoderSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let dataLines: string[] = [];

  const emitEvent = (controller: TransformStreamDefaultController<Uint8Array>) => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (!payload || payload === "[DONE]") return;
    const inner = extractQoderBody(payload);
    if (!inner || isQoderFinishMetadata(inner)) return;
    controller.enqueue(encoder.encode(`data: ${inner}\n\n`));
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line === "") {
            emitEvent(controller);
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
        emitEvent(controller);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    }),
  );
}

export async function qoderSseToChatCompletion(
  body: ReadableStream<Uint8Array>,
  model: string,
): Promise<JsonRecord> {
  const reader = transformQoderSse(body).getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  const state = createCompletionState(model);
  for (const block of text.split(/\r?\n\r?\n/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload || payload === "[DONE]") continue;
    try {
      consumeCompletionEvent(state, JSON.parse(payload));
    } catch {
      // Ignore malformed upstream events, matching streaming clients' behavior.
    }
  }
  return finishCompletion(state);
}

function encryptAesCbc(plaintext: string, key: string): string {
  const keyBytes = Buffer.from(key, "utf8");
  const cipher = createCipheriv("aes-128-cbc", keyBytes, keyBytes);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

function md5(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

function qoderMessageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      return typeof part.content === "string" ? part.content : "";
    })
    .join("");
}

function extractQoderBody(payload: string): string {
  try {
    const envelope = JSON.parse(payload);
    if (!isRecord(envelope)) return payload;
    if (!("body" in envelope)) return envelope.statusCode ? "" : payload;
    if (typeof envelope.body === "string") return envelope.body;
    return envelope.body == null ? "" : JSON.stringify(envelope.body);
  } catch {
    return payload;
  }
}

function isQoderFinishMetadata(inner: string): boolean {
  if (inner === "event:finish") return true;
  try {
    const value = JSON.parse(inner);
    return isRecord(value) && "event" in value && !("choices" in value) && !("type" in value);
  } catch {
    return false;
  }
}

interface CompletionState {
  id: string;
  created: number;
  model: string;
  systemFingerprint?: string;
  content: string;
  reasoningContent: string;
  refusal: string;
  role: string;
  finishReason: string | null;
  toolCalls: Map<number, JsonRecord>;
  responseTools: JsonRecord[];
  currentResponseTool?: JsonRecord;
  usage: JsonRecord;
}

function createCompletionState(model: string): CompletionState {
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    content: "",
    reasoningContent: "",
    refusal: "",
    role: "assistant",
    finishReason: null,
    toolCalls: new Map(),
    responseTools: [],
    usage: {},
  };
}

function consumeCompletionEvent(state: CompletionState, event: JsonRecord): void {
  if (typeof event.id === "string") state.id = event.id;
  if (typeof event.created === "number") state.created = event.created;
  if (typeof event.model === "string") state.model = event.model;
  if (typeof event.system_fingerprint === "string") {
    state.systemFingerprint = event.system_fingerprint;
  }
  if (isRecord(event.usage)) state.usage = event.usage;

  const choice = Array.isArray(event.choices) && isRecord(event.choices[0])
    ? event.choices[0]
    : undefined;
  if (choice) {
    const message = isRecord(choice.delta)
      ? choice.delta
      : isRecord(choice.message)
        ? choice.message
        : undefined;
    if (message) consumeMessage(state, message);
    if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
  }

  const type = typeof event.type === "string" ? event.type : "";
  if (type === "response.output_item.added" && isRecord(event.item)) {
    if (event.item.type === "function_call") {
      state.currentResponseTool = {
        id: event.item.id ?? event.item.call_id ?? randomUUID(),
        type: "function",
        function: { name: event.item.name ?? "", arguments: "" },
      };
    }
  } else if (type === "response.output_text.delta" && typeof event.delta === "string") {
    state.content += event.delta;
  } else if (
    type === "response.function_call_arguments.delta" &&
    state.currentResponseTool &&
    typeof event.delta === "string"
  ) {
    state.currentResponseTool.function.arguments += event.delta;
  } else if (
    (type === "response.function_call_arguments.done" || type === "response.output_item.done") &&
    state.currentResponseTool
  ) {
    state.responseTools.push(state.currentResponseTool);
    state.currentResponseTool = undefined;
  } else if (type === "response.completed" || type === "response.done") {
    const response = isRecord(event.response) ? event.response : event;
    if (isRecord(response.usage)) state.usage = response.usage;
    state.finishReason = response.status === "failed" ? "stop" : (state.finishReason ?? "stop");
  }
}

function consumeMessage(state: CompletionState, message: JsonRecord): void {
  if (typeof message.role === "string") state.role = message.role;
  if (typeof message.content === "string") state.content += message.content;
  if (typeof message.reasoning_content === "string") {
    state.reasoningContent += message.reasoning_content;
  }
  if (typeof message.refusal === "string") state.refusal += message.refusal;
  if (!Array.isArray(message.tool_calls)) return;

  for (const raw of message.tool_calls) {
    if (!isRecord(raw)) continue;
    const index = typeof raw.index === "number" ? raw.index : state.toolCalls.size;
    const current = state.toolCalls.get(index) ?? {
      id: raw.id ?? "",
      type: raw.type ?? "function",
      function: { name: "", arguments: "" },
    };
    if (typeof raw.id === "string") current.id = raw.id;
    if (typeof raw.type === "string") current.type = raw.type;
    if (isRecord(raw.function)) {
      if (typeof raw.function.name === "string") current.function.name += raw.function.name;
      if (typeof raw.function.arguments === "string") {
        current.function.arguments += raw.function.arguments;
      }
    }
    state.toolCalls.set(index, current);
  }
}

function finishCompletion(state: CompletionState): JsonRecord {
  if (state.currentResponseTool) state.responseTools.push(state.currentResponseTool);
  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, tool]) => tool)
    .concat(state.responseTools);
  const message: JsonRecord = { role: state.role, content: state.content || null };
  if (state.reasoningContent) message.reasoning_content = state.reasoningContent;
  if (state.refusal) message.refusal = state.refusal;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: state.id,
    object: "chat.completion",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: state.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    usage: state.usage,
    ...(state.systemFingerprint
      ? { system_fingerprint: state.systemFingerprint }
      : {}),
  };
}

function positiveNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
