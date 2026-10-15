import { Effect, Option, Result, Schema } from "effect";
import { type H3Event } from "h3";
import { getQuotaAccount } from "@opendum/database/queries";
import { fetchAccountQuota, isQuotaProvider } from "@opendum/providers/quota";
import type { QuotaContext, QuotaJournal } from "@opendum/providers/quota";
import { assertPublicHost, PrivateHostError } from "@opendum/core/egress";
import { decrypt } from "@opendum/core/crypto";
import type { ProxyContext } from "../core/context.js";
import { parseJson, trySyncResult, utf8ByteLength } from "../core/helpers.js";
import { validateInternalSignature } from "../core/internal-signature.js";
import { jsonResponse } from "./errors.js";

const MAX_QUOTA_BODY_BYTES = 64 * 1024;
const MAX_RELAY_BODY_BYTES = 2 << 20;
const RELAY_TIMEOUT_MS = 20 * 1000;

const QuotaInputSchema = Schema.Struct({
  userId: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  accountId: Schema.optional(Schema.String),
  forceRefresh: Schema.optional(Schema.Boolean),
});

const RelayInputSchema = Schema.Struct({
  url: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optional(Schema.Unknown),
});

const decodeQuotaInput = Schema.decodeUnknownOption(QuotaInputSchema, { onExcessProperty: "error" });
const decodeRelayInput = Schema.decodeUnknownOption(RelayInputSchema, { onExcessProperty: "error" });

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

export async function handleQuota(event: H3Event, context: ProxyContext): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const rawBody = yield* Effect.promise(() => event.req.text());
      if (utf8ByteLength(rawBody) > MAX_QUOTA_BODY_BYTES) {
        return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
      }
      const valid = yield* Effect.promise(() =>
        validateInternalSignature(context.config.betterAuthSecret, event.req, "/internal/quota", rawBody)
      );
      if (!valid) {
        return jsonResponse({ success: false, error: "Invalid internal quota signature" }, 401);
      }
      const parsed = yield* Effect.sync(() => parseJson(rawBody));
      const decoded = Option.getOrNull(decodeQuotaInput(Result.isSuccess(parsed) ? parsed.success : null));
      if (decoded === null) {
        return jsonResponse({ success: false, error: "Invalid quota payload" }, 400);
      }
      const userId = (decoded.userId ?? "").trim();
      const provider = (decoded.provider ?? "").trim();
      const accountId = (decoded.accountId ?? "").trim();
      if (!userId || !provider || !accountId) {
        return jsonResponse({ success: false, error: "userId, provider, and accountId are required" }, 400);
      }
      if (!isQuotaProvider(provider)) {
        return jsonResponse({ success: false, error: `provider ${provider} is not supported for quota` }, 200);
      }

      const row = yield* Effect.promise(() => getQuotaAccount(accountId, userId, provider));
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
      const result = yield* fetchAccountQuota(
        quotaContext(context),
        account,
        Boolean(decoded.forceRefresh)
      );
      return jsonResponse({ success: true, data: result }, 200);
    }).pipe(Effect.withSpan("handleQuota"))
  );
}

function resolveRelayTarget(url: string, method: string): { method: string; target: string } {
  const normalizedMethod = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    throw new Error(`unsupported internal relay method: ${normalizedMethod}`);
  }
  if (!URL.canParse(url)) throw new Error("url is invalid");
  const target = new URL(url);
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password) {
    throw new Error("url must be an https provider URL");
  }
  const hostCheck = trySyncResult(() => assertPublicHost(target.hostname));
  if (Result.isFailure(hostCheck)) {
    if (hostCheck.failure instanceof PrivateHostError) throw new Error("url must not target a private network address");
    throw hostCheck.failure;
  }
  return { method: normalizedMethod, target: target.toString() };
}

export async function handleRefresh(event: H3Event, context: ProxyContext): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const rawBody = yield* Effect.promise(() => event.req.text());
      if (utf8ByteLength(rawBody) > MAX_RELAY_BODY_BYTES) {
        return relayError(400, "Invalid internal refresh payload");
      }
      const valid = yield* Effect.promise(() =>
        validateInternalSignature(context.config.betterAuthSecret, event.req, "/internal/refresh", rawBody)
      );
      if (!valid) return relayError(401, "Invalid internal refresh signature");

      const parsed = yield* Effect.sync(() => parseJson(rawBody));
      const decoded = Option.getOrNull(decodeRelayInput(Result.isSuccess(parsed) ? parsed.success : null));
      if (decoded === null) {
        return relayError(400, "Invalid internal refresh payload");
      }
      const url = (decoded.url ?? "").trim();
      if (!url) return relayError(400, "url is required");

      const resolved = yield* Effect.try({
        try: () => resolveRelayTarget(url, decoded.method ?? ""),
        catch: (error) => (error instanceof Error ? error : new Error("Invalid target")),
      }).pipe(Effect.result);
      if (resolved._tag === "Failure") return relayError(400, resolved.failure.message);

      const headers = new Headers();
      for (const [key, value] of Object.entries(decoded.headers ?? {})) {
        const normalized = key.trim().toLowerCase();
        if (!normalized || normalized.startsWith(":") || normalized.startsWith("proxy-")) continue;
        if (BLOCKED_RELAY_HEADERS.has(normalized)) continue;
        if (!value.trim()) continue;
        headers.set(normalized, value);
      }

      let body: string | undefined;
      if (decoded.body !== undefined && decoded.body !== null) {
        body = typeof decoded.body === "string" ? decoded.body : JSON.stringify(decoded.body);
      }

      const upstream = yield* Effect.tryPromise({
        try: () =>
          context.guardedFetch(resolved.success.target, {
            method: resolved.success.method,
            headers,
            body,
            signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.result);
      if (upstream._tag === "Failure") {
        return relayError(502, `Internal relay upstream request failed: ${upstream.failure.message}`);
      }

      const responseHeaders = new Headers();
      upstream.success.headers.forEach((value, key) => {
        const normalized = key.toLowerCase();
        if (normalized.startsWith("proxy-")) return;
        if (BLOCKED_RELAY_RESPONSE_HEADERS.has(normalized)) return;
        responseHeaders.append(key, value);
      });
      const text = yield* Effect.promise(() => upstream.success.text());
      return new Response(text, { status: upstream.success.status, headers: responseHeaders });
    }).pipe(Effect.withSpan("handleRefresh"))
  );
}

function relayError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", "X-Opendum-Internal-Relay-Error": "1" },
  });
}
