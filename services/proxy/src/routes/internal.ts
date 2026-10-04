import { defineHandler, type H3, type H3Event } from "h3";
import { getQuotaAccount } from "@opendum/database/queries";
import { fetchAccountQuota, isQuotaProvider } from "@opendum/quota";
import type { QuotaContext, QuotaJournal } from "@opendum/quota";
import { assertPublicHost, PrivateHostError } from "@opendum/egress";
import { decrypt } from "@opendum/crypto";
import type { ProxyContext } from "../context.js";
import { validateInternalSignature } from "../middleware/internal-signature.js";
import { jsonResponse } from "./errors.js";

const MAX_QUOTA_BODY_BYTES = 64 * 1024;
const MAX_RELAY_BODY_BYTES = 2 << 20;
const RELAY_TIMEOUT_MS = 20 * 1000;

const BLOCKED_RELAY_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "accept-encoding", "forwarded", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
]);

const BLOCKED_RELAY_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "set-cookie",
]);

function redisJournal(context: ProxyContext): QuotaJournal {
  return {
    get: (key) => context.redis.get(key),
    async set(key, value, ttlSeconds) {
      await context.redis.set(key, value, { EX: ttlSeconds });
    },
  };
}

function quotaContext(context: ProxyContext): QuotaContext {
  return {
    fetch: (url, init) => context.guardedFetch(url, init),
    journal: redisJournal(context),
    decrypt: (value) => decrypt(context.config.betterAuthSecret, value),
    getCredentials: (account) => context.service.quotaCredentials(account),
  };
}

async function handleQuota(event: H3Event, context: ProxyContext): Promise<Response> {
  const rawBody = await event.req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_QUOTA_BODY_BYTES) {
    return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
  }
  const valid = await validateInternalSignature(context.config.betterAuthSecret, event.req, "/internal/quota", rawBody);
  if (!valid) {
    return jsonResponse({ success: false, error: "Invalid internal quota signature" }, 401);
  }
  let input: { userId?: string; provider?: string; accountId?: string; forceRefresh?: boolean };
  try {
    input = JSON.parse(rawBody) as typeof input;
  } catch {
    return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
  }
  const allowed = new Set(["userId", "provider", "accountId", "forceRefresh"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
  }
  if (input.forceRefresh !== undefined && typeof input.forceRefresh !== "boolean") {
    return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
  }
  const userId = (input.userId ?? "").trim();
  const provider = (input.provider ?? "").trim();
  const accountId = (input.accountId ?? "").trim();
  if (!userId || !provider || !accountId) {
    return jsonResponse({ success: false, error: "userId, provider, and accountId are required" }, 400);
  }
  if (!isQuotaProvider(provider)) {
    return jsonResponse({ success: false, error: `provider ${provider} is not supported for quota` }, 200);
  }

  const row = await getQuotaAccount(accountId, userId, provider);
  if (!row) return jsonResponse({ success: false, error: "Account not found" }, 404);

  const account = {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    projectId: row.projectId,
    accountId: row.accountId,
    tier: row.tier,
    accessToken: row.accessToken,
  };
  try {
    const result = await fetchAccountQuota(quotaContext(context), account, Boolean(input.forceRefresh));
    return jsonResponse({ success: true, data: result }, 200);
  } catch (error) {
    return jsonResponse(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch quota" },
      200
    );
  }
}

function resolveRelayTarget(url: string, method: string): { method: string; target: string } {
  const normalizedMethod = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    throw new Error(`unsupported internal relay method: ${normalizedMethod}`);
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("url is invalid");
  }
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password) {
    throw new Error("url must be an https provider URL");
  }
  try {
    assertPublicHost(target.hostname);
  } catch (error) {
    if (error instanceof PrivateHostError) throw new Error("url must not target a private network address", { cause: error });
    throw error;
  }
  return { method: normalizedMethod, target: target.toString() };
}

async function handleRefresh(event: H3Event, context: ProxyContext): Promise<Response> {
  const rawBody = await event.req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_RELAY_BODY_BYTES) {
    return relayError(400, "Invalid internal refresh payload");
  }
  const valid = await validateInternalSignature(context.config.betterAuthSecret, event.req, "/internal/refresh", rawBody);
  if (!valid) return relayError(401, "Invalid internal refresh signature");

  let input: { url?: string; method?: string; headers?: Record<string, string>; body?: unknown };
  try {
    input = JSON.parse(rawBody) as typeof input;
  } catch {
    return relayError(400, "Invalid internal refresh payload");
  }
  const url = (input.url ?? "").trim();
  if (!url) return relayError(400, "url is required");

  let resolved: { method: string; target: string };
  try {
    resolved = resolveRelayTarget(url, input.method ?? "");
  } catch (error) {
    return relayError(400, error instanceof Error ? error.message : "Invalid target");
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || normalized.startsWith(":") || normalized.startsWith("proxy-")) continue;
    if (BLOCKED_RELAY_HEADERS.has(normalized)) continue;
    if (!value.trim()) continue;
    headers.set(normalized, value);
  }

  let body: string | undefined;
  if (input.body !== undefined && input.body !== null) {
    body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  }

  let upstream: Response;
  try {
    upstream = await context.guardedFetch(resolved.target, {
      method: resolved.method,
      headers,
      body,
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (error) {
    return relayError(502, `Internal relay upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("proxy-")) return;
    if (BLOCKED_RELAY_RESPONSE_HEADERS.has(normalized)) return;
    responseHeaders.append(key, value);
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: responseHeaders });
}

function relayError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "X-Opendum-Internal-Relay-Error": "1" },
  });
}

export function registerInternalRoutes(app: H3, context: ProxyContext): void {
  app.post(
    "/internal/quota",
    defineHandler((event) => handleQuota(event, context))
  );
  app.post(
    "/internal/refresh",
    defineHandler((event) => handleRefresh(event, context))
  );
}
