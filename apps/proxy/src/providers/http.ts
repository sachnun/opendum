import type { HttpClient, RequestContext, UpstreamResponse } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function streamFromString(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

export function jsonResponse(status: number, payload: unknown): UpstreamResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: streamFromString(JSON.stringify(payload)),
  };
}

export function errorResponse(status: number, message: string, type = "invalid_request_error"): UpstreamResponse {
  return jsonResponse(status, { error: { message, type } });
}

export function sseResponse(gen: AsyncGenerator<string>): UpstreamResponse {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    body: streamFromAsyncIterable(gen),
  };
}

export function streamFromAsyncIterable(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await gen.return?.(undefined);
    },
  });
}

export async function readAllText(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return decoder.decode(concatChunks(chunks));
}

export function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function readAllJSON<T = Record<string, unknown>>(body: ReadableStream<Uint8Array> | null): Promise<T | null> {
  const text = await readAllText(body);
  if (text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Node fetch adapter returning our UpstreamResponse abstraction. */
export function nodeHttpClient(): HttpClient {
  return {
    async fetch(url, init) {
      const body = init.body instanceof Uint8Array ? Buffer.from(init.body) : (init.body as BodyInit | null | undefined);
      const res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body,
        signal: init.signal,
      });
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: res.body,
      };
    },
  };
}

export function postJSON(
  client: HttpClient,
  ctx: RequestContext,
  url: string,
  bearer: string,
  payload: Record<string, unknown>,
  stream: boolean,
): Promise<UpstreamResponse> {
  return postJSONWithHeaders(client, ctx, url, bearer, payload, stream, null);
}

export function postJSONWithHeaders(
  client: HttpClient,
  ctx: RequestContext,
  url: string,
  bearer: string,
  payload: Record<string, unknown>,
  stream: boolean,
  extraHeaders: Record<string, string> | null,
): Promise<UpstreamResponse> {
  return postJSONWithHeadersAuth(client, ctx, url, bearer, payload, stream, extraHeaders, true);
}

export function postJSONWithoutAuth(
  client: HttpClient,
  ctx: RequestContext,
  url: string,
  payload: Record<string, unknown>,
  stream: boolean,
): Promise<UpstreamResponse> {
  return postJSONWithHeadersAuth(client, ctx, url, "", payload, stream, null, false);
}

export function postJSONWithHeadersAuth(
  client: HttpClient,
  ctx: RequestContext,
  url: string,
  bearer: string,
  payload: Record<string, unknown>,
  stream: boolean,
  extraHeaders: Record<string, string> | null,
  useAuth: boolean,
): Promise<UpstreamResponse> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {};
  if (useAuth) headers["authorization"] = "Bearer " + bearer.trim();
  headers["content-type"] = "application/json";
  headers["accept"] = stream ? "text/event-stream" : "application/json";
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      headers[key.toLowerCase()] = value;
    }
  }
  return client.fetch(url, { method: "POST", headers, body, signal: ctx.signal });
}

export function getJSON(
  client: HttpClient,
  ctx: RequestContext,
  method: string,
  target: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<UpstreamResponse> {
  const initHeaders: Record<string, string> = { ...headers };
  let reqBody: string | null = null;
  if (body !== undefined && body !== null) {
    reqBody = JSON.stringify(body);
    if (!initHeaders["content-type"]) initHeaders["content-type"] = "application/json";
  }
  return client.fetch(target, { method, headers: initHeaders, body: reqBody, signal: ctx.signal });
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function defaultStringValue(value: unknown, fallback: string): string {
  if (typeof value === "string" && value !== "") return value;
  return fallback;
}

export function defaultAny(value: unknown, fallback: unknown): unknown {
  return value !== undefined && value !== null ? value : fallback;
}

export function numberFromAny(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof value === "bigint") return Number(value);
  return 0;
}

export function numberAsFloat(value: unknown): number {
  return numberFromAny(value);
}

export function readLimitText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return Promise.resolve("");
  return readAllText(body).then((text) => text.slice(0, limit));
}

export function randomHex(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomID(prefix: string): string {
  return prefix + "_" + randomHex(16);
}

/** Yield trimmed lines from a web ReadableStream (buffers partial lines). */
export async function* iterateLines(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield line;
    }
  }
  if (buffer !== "") yield buffer;
}

/** Split text into "\n\n"-separated SSE events, yielding data payloads. */
export async function* iterateSSEPayloads(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  let buffer = "";
  for await (const line of iterateLines(body)) {
    buffer += line.replace(/\r/g, "") + "\n";
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (data !== "" && data !== "[DONE]") yield data;
    }
  }
  if (buffer.trim() !== "") {
    const data = buffer.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (data !== "" && data !== "[DONE]") yield data;
  }
}
