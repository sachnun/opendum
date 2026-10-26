import { ORPCError } from "@orpc/server";
import { Effect } from "effect";
import { hostError } from "@opendum/core/egress";

import type { QuotaInput, RelayInput, RelayResult } from "@opendum/providers/contract";
import type { ProxyContext } from "@opendum/api/core/context";
import { fetchQuota } from "@opendum/api/core/quota";
import { fromPromise } from "@opendum/api/web/lib/task";

const RELAY_TIMEOUT_MS = 20 * 1000;

const BLOCKED_RELAY_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "accept-encoding", "forwarded", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
]);

const BLOCKED_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "set-cookie",
]);

export const opsQuota = Effect.fn("ops.runAccountQuota")(function* (
  context: ProxyContext,
  input: QuotaInput
) {
  const userId = (input.userId ?? "").trim();
  const provider = (input.provider ?? "").trim();
  const accountId = (input.accountId ?? "").trim();
  if (!userId || !provider || !accountId) {
    return { success: false as const, error: "userId, provider, and accountId are required" };
  }

  const outcome = yield* fromPromise(
    () =>
      fetchQuota(context, {
        userId,
        provider,
        accountId,
        forceRefresh: Boolean(input.forceRefresh),
      }),
    "Failed to fetch quota data"
  );
  if (outcome.status === "unsupported") {
    return { success: false as const, error: `provider ${outcome.provider} is not supported for quota` };
  }
  if (outcome.status === "not-found") return { success: false as const, error: "Account not found" };
  if (outcome.status === "error") return { success: false as const, error: outcome.message };

  return { success: true as const, data: outcome.data };
});

function relayTarget(
  url: string,
  method: string
): { method: string; target: string } | { error: string } {
  const normalizedMethod = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    return { error: `unsupported relay method: ${normalizedMethod}` };
  }
  if (!URL.canParse(url)) return { error: "url is invalid" };
  const target = new URL(url);
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password) {
    return { error: "url must be an https provider URL" };
  }
  const hostIssue = hostError(target.hostname);
  if (hostIssue) return { error: "url must not target a private network address" };
  return { method: normalizedMethod, target: target.toString() };
}

export const runOpsRelay = Effect.fn("ops.runRelay")(function* (
  context: ProxyContext,
  input: RelayInput
) {
  const url = (input.url ?? "").trim();
  if (!url) return yield* Effect.fail(new ORPCError("BAD_REQUEST", { message: "url is required" }));

  const resolved = relayTarget(url, input.method ?? "");
  if ("error" in resolved) {
    return yield* Effect.fail(new ORPCError("BAD_REQUEST", { message: resolved.error }));
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

  const upstream = yield* Effect.tryPromise({
    try: () =>
      context.guardedFetch(resolved.target, {
        method: resolved.method,
        headers,
        body,
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      }),
    catch: (error) =>
      new ORPCError("BAD_GATEWAY", {
        message: `Relay upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("proxy-")) return;
    if (BLOCKED_HEADERS.has(normalized)) return;
    responseHeaders[key] = value;
  });

  const responseBody = yield* fromPromise(
    () => upstream.text(),
    "Relay upstream response failed"
  );
  return { status: upstream.status, headers: responseHeaders, body: responseBody } satisfies RelayResult;
});
