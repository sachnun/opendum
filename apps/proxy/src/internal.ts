import type { HttpClient } from "./providers/types.js";

const internalRelayMaxBodyBytes = 2 << 20;

interface InternalRelayRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export class InternalRelay {
  constructor(
    private client: HttpClient,
    private secret: string,
    private validateSignature: (request: Request, path: string, body: Uint8Array) => boolean,
  ) {}

  async handle(request: Request, path: string): Promise<{ status: number; headers: Record<string, string>; body: string | ReadableStream<Uint8Array> }> {
    const rawBody = await readLimited(request, internalRelayMaxBodyBytes);
    if (!this.validateSignature(request, path, rawBody)) {
      return relayError(401, "Invalid internal refresh signature");
    }

    let input: InternalRelayRequest;
    try {
      input = JSON.parse(new TextDecoder().decode(rawBody)) as InternalRelayRequest;
    } catch {
      return relayError(400, "Invalid internal refresh payload");
    }

    input.url = input.url.trim();
    if (input.url === "") {
      return relayError(400, "url is required");
    }

    let method = (input.method ?? "GET").trim().toUpperCase();
    if (method === "") method = "GET";
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return relayError(400, `Unsupported internal relay method: ${method}`);
    }

    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      return relayError(400, "url is invalid");
    }
    if (target.protocol !== "https:" || target.hostname === "" || target.username !== "" || target.password !== "") {
      return relayError(400, "url must be an https provider URL");
    }

    let body: string | undefined;
    if (input.body !== undefined && input.body !== null) {
      if (typeof input.body === "string") {
        body = input.body;
      } else {
        body = JSON.stringify(input.body);
      }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers ?? {})) {
      const normalized = key.trim().toLowerCase();
      if (isBlockedInternalRelayHeader(normalized) || value.trim() === "") continue;
      headers[key] = value;
    }

    let resp;
    try {
      resp = await this.client.fetch(target.toString(), { method, headers, body, signal: request.signal });
    } catch (error) {
      return relayError(502, `Internal relay upstream request failed: ${(error as Error).message}`);
    }

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(resp.headers)) {
      if (isBlockedInternalRelayResponseHeader(key.toLowerCase())) continue;
      responseHeaders[key] = value;
    }
    return { status: resp.status, headers: responseHeaders, body: resp.body ?? "" };
  }
}

function relayError(status: number, message: string): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: { "content-type": "application/json", "x-opendum-internal-relay-error": "1" }, body: JSON.stringify({ error: message }) };
}

async function readLimited(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    chunks.push(value);
    if (total >= limit) break;
  }
  const out = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, limit - offset);
    out.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= limit) break;
  }
  return out;
}

function isBlockedInternalRelayHeader(header: string): boolean {
  if (header === "" || header.startsWith(":") || header.startsWith("proxy-")) return true;
  switch (header) {
    case "host":
    case "connection":
    case "keep-alive":
    case "proxy-authenticate":
    case "proxy-authorization":
    case "te":
    case "trailer":
    case "transfer-encoding":
    case "upgrade":
    case "content-length":
    case "accept-encoding":
    case "forwarded":
    case "x-forwarded-for":
    case "x-forwarded-host":
    case "x-forwarded-proto":
    case "x-real-ip":
      return true;
    default:
      return false;
  }
}

function isBlockedInternalRelayResponseHeader(header: string): boolean {
  if (header === "" || header.startsWith("proxy-")) return true;
  switch (header) {
    case "connection":
    case "keep-alive":
    case "proxy-authenticate":
    case "proxy-authorization":
    case "te":
    case "trailer":
    case "transfer-encoding":
    case "upgrade":
    case "content-length":
    case "set-cookie":
      return true;
    default:
      return false;
  }
}
