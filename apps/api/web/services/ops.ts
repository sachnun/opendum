import { ORPCError } from "@orpc/server";
import { assertPublicHost, PrivateHostError } from "@opendum/core/egress";
import { Result } from "effect";

import type { QuotaInput, QuotaResult, RelayInput, RelayResult } from "@opendum/providers/contract";
import type { ProxyContext } from "../../core/context.js";
import { trySyncResult } from "../../core/helpers.js";
import { fetchAccountQuota } from "../../core/quota.js";

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

export async function runOpsAccountQuota(context: ProxyContext, input: QuotaInput): Promise<QuotaResult> {
  const userId = (input.userId ?? "").trim();
  const provider = (input.provider ?? "").trim();
  const accountId = (input.accountId ?? "").trim();
  if (!userId || !provider || !accountId) {
    return { success: false, error: "userId, provider, and accountId are required" };
  }

  const outcome = await fetchAccountQuota(context, { userId, provider, accountId, forceRefresh: Boolean(input.forceRefresh) });
  if (outcome.status === "unsupported") return { success: false, error: `provider ${outcome.provider} is not supported for quota` };
  if (outcome.status === "not-found") return { success: false, error: "Account not found" };
  if (outcome.status === "error") return { success: false, error: outcome.message };

  return { success: true, data: outcome.data };
}

function resolveRelayTarget(url: string, method: string): { method: string; target: string } {
  const normalizedMethod = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) {
    throw new Error(`unsupported relay method: ${normalizedMethod}`);
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

export async function runOpsRelay(context: ProxyContext, input: RelayInput): Promise<RelayResult> {
  const url = (input.url ?? "").trim();
  if (!url) throw new ORPCError("BAD_REQUEST", { message: "url is required" });

  let resolved: { method: string; target: string };
  try {
    resolved = resolveRelayTarget(url, input.method ?? "");
  } catch (error) {
    throw new ORPCError("BAD_REQUEST", { message: error instanceof Error ? error.message : "Invalid target" });
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
    throw new ORPCError("BAD_GATEWAY", {
      message: `Relay upstream request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("proxy-")) return;
    if (BLOCKED_RELAY_RESPONSE_HEADERS.has(normalized)) return;
    responseHeaders[key] = value;
  });

  return { status: upstream.status, headers: responseHeaders, body: await upstream.text() };
}
