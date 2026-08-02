import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Registry } from "../registry/index.js";
import { postJSONWithHeaders, stringValue, readAllText } from "./http.js";
import { convertImageURLsToBase64 } from "./images.js";
import type { HttpClient, Provider, ProviderAccountLike, RequestContext, UpstreamResponse } from "./types.js";

const mimoCodeBootstrapURL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const mimoCodeChatURL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";
const mimoCodeSource = "mimocode-cli-free";
const mimoCodeSystemMarker = "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";
const mimoCodeJWTFallbackTTL = 3000 * 1000;
const mimoCodeJWTBuffer = 5 * 60 * 1000;

const mimoCodeSessionPrefix = "ses_";
const mimoCodeSessionLen = 24;

let cachedJWT = "";
let jwtExpires = 0;
let sessionIDOnce: string | null = null;

function generateMimoCodeFingerprint(): string {
  const host = hostname() || "unknown-host";
  const seed = `${host}|linux|x64|unknown-user`;
  return createHash("sha256").update(seed).digest("hex");
}

function generateMimoCodeSessionID(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = randomBytes(mimoCodeSessionLen);
  let id = mimoCodeSessionPrefix;
  for (const b of buf) id += chars[b % chars.length];
  return id;
}

function mimoCodeSessionOnce(): string {
  if (sessionIDOnce === null) sessionIDOnce = generateMimoCodeSessionID();
  return sessionIDOnce;
}

function parseMimoCodeJWTExp(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length < 2) return 0;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" && payload.exp > 0 ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function bootstrapMimoCodeJWT(client: HttpClient, ctx: RequestContext): Promise<string> {
  if (cachedJWT !== "" && Date.now() < jwtExpires - mimoCodeJWTBuffer) {
    return cachedJWT;
  }

  const fingerprint = generateMimoCodeFingerprint();
  const resp = await client.fetch(mimoCodeBootstrapURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client: fingerprint }),
    signal: ctx.signal,
  });
  if (resp.status < 200 || resp.status >= 300) {
    const body = await readAllText(resp.body);
    throw new Error(`mimo_code bootstrap failed: ${resp.status} ${body.trim()}`);
  }
  const payload = (await readAllJSONSafe(resp.body)) as { jwt?: unknown };
  const jwt = stringValue(payload["jwt"]);
  if (jwt === "") {
    throw new Error("mimo_code bootstrap returned no jwt");
  }
  const exp = parseMimoCodeJWTExp(jwt);
  jwtExpires = exp !== 0 ? exp : Date.now() + mimoCodeJWTFallbackTTL;
  cachedJWT = jwt;
  return jwt;
}

function injectMimoCodeSystemMarker(body: Record<string, unknown>): void {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    const mm = (m ?? {}) as Record<string, unknown>;
    if (stringValue(mm["role"]) === "system" && stringValue(mm["content"]).includes(mimoCodeSystemMarker)) {
      return;
    }
  }
  body["messages"] = [{ role: "system", content: mimoCodeSystemMarker }, ...messages];
}

const supportedMimoCode = new Set(["model", "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "presence_penalty", "frequency_penalty", "n", "stop", "seed", "response_format", "reasoning", "reasoning_effort"]);

export class MimoCodeProvider implements Provider {
  constructor(private registry: Registry | null) {}

  authless(): boolean {
    return true;
  }

  async makeRequest(client: HttpClient, ctx: RequestContext, _credentials: string, _account: ProviderAccountLike, body: Record<string, unknown>, stream: boolean): Promise<UpstreamResponse> {
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (supportedMimoCode.has(key) && value !== undefined && value !== null) {
        payload[key] = value;
      }
    }
    let model = stringValue(body["model"]);
    if (model.startsWith("mimo_code/")) {
      model = model.slice("mimo_code/".length);
    }
    if (this.registry) {
      model = this.registry.upstreamModelName(model, "mimo_code");
    }
    payload["model"] = model;
    payload["stream"] = stream;
    if (Array.isArray(payload["messages"])) {
      payload["messages"] = await convertImageURLsToBase64(client, ctx, payload["messages"] as unknown[]);
    }
    injectMimoCodeSystemMarker(payload);

    const headers: Record<string, string> = {
      "x-mimo-source": mimoCodeSource,
      "x-session-affinity": mimoCodeSessionOnce(),
    };

    const jwt = await bootstrapMimoCodeJWT(client, ctx);
    let resp = await postJSONWithHeaders(client, ctx, mimoCodeChatURL, jwt, payload, stream, headers);
    if (resp.status !== 401 && resp.status !== 403) return resp;

    cachedJWT = "";
    jwtExpires = 0;
    const jwt2 = await bootstrapMimoCodeJWT(client, ctx);
    return postJSONWithHeaders(client, ctx, mimoCodeChatURL, jwt2, payload, stream, headers);
  }
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
